import type { ImportError } from '@forgeax/engine-types';

export type SourcePackageErrorCode =
  | 'source-package-meta-invalid'
  | 'source-package-importer-missing'
  | 'source-package-conversion-failed'
  | 'source-package-ddc-failed'
  | 'source-package-publication-invalid'
  | 'source-package-guid-closure-mismatch';

export type SourcePackageErrorStage =
  | 'meta'
  | 'importer'
  | 'conversion'
  | 'closure'
  | 'ddc'
  | 'route-integrity';

export interface SourcePackageErrorContext {
  readonly sourceMeta: string;
  readonly anchorGuid: string;
  readonly affectedGuids: readonly string[];
  readonly producer: string;
  readonly importer: string;
}

export interface SourcePackageErrorDetail extends SourcePackageErrorContext {
  readonly stage: SourcePackageErrorStage;
  readonly reason?: string;
  readonly missing?: readonly string[];
  readonly unexpected?: readonly string[];
  readonly registeredImporters?: readonly string[];
}

export interface SourcePackageError {
  readonly code: SourcePackageErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SourcePackageErrorDetail;
}

const EXPECTED: Readonly<Record<SourcePackageErrorCode, string>> = {
  'source-package-meta-invalid': 'a valid source Meta declaration with complete GUID topology',
  'source-package-importer-missing': 'a registered importer for the source Meta importer key',
  'source-package-conversion-failed': 'the configured importer to convert the source successfully',
  'source-package-ddc-failed': 'a readable persistent DDC entry with matching integrity evidence',
  'source-package-publication-invalid':
    'a complete Pack body, refs, artifacts, and route integrity',
  'source-package-guid-closure-mismatch': 'exactly one produced asset for every declared GUID',
};

const HINT: Readonly<Record<SourcePackageErrorCode, string>> = {
  'source-package-meta-invalid':
    'repair the Meta declaration, then rebuild or cold-cook the source package',
  'source-package-importer-missing':
    'register the named importer, then rebuild or cold-cook the source package',
  'source-package-conversion-failed':
    'repair the source or importer, then rebuild or cold-cook the source package',
  'source-package-ddc-failed':
    'discard the invalid derived entry, then rebuild or cold-cook the source package',
  'source-package-publication-invalid':
    'repair the missing product bytes, then rebuild or cold-cook the source package',
  'source-package-guid-closure-mismatch':
    'repair the Meta topology or importer output, then rebuild the whole source package',
};

export function sourcePackageError(
  code: SourcePackageErrorCode,
  context: SourcePackageErrorContext,
  detail: Omit<SourcePackageErrorDetail, keyof SourcePackageErrorContext>,
): SourcePackageError {
  return {
    code,
    expected: EXPECTED[code],
    hint: HINT[code],
    detail: { ...context, ...detail },
  };
}

function unknownReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function importFailureCode(error: ImportError): SourcePackageErrorCode {
  switch (error.code) {
    case 'importer-not-registered':
      return 'source-package-importer-missing';
    case 'import-produced-no-assets':
    case 'guid-mismatch':
    case 'source-validation-failed':
      return 'source-package-guid-closure-mismatch';
    case 'source-read-failed':
    case 'import-internal-error':
    case 'unknown-source-key':
    case 'duplicate-source-key':
    case 'invalid-source-overrides':
    case 'invalid-source-override-payload':
      return 'source-package-conversion-failed';
  }
}

export function normalizeSourcePackageError(
  error: unknown,
  context: SourcePackageErrorContext,
): SourcePackageError {
  if (isImportError(error)) {
    const code = importFailureCode(error);
    const detail: Omit<SourcePackageErrorDetail, keyof SourcePackageErrorContext> = {
      stage: code === 'source-package-importer-missing' ? 'importer' : 'conversion',
      reason: unknownReason(error),
      ...(code === 'source-package-importer-missing' && 'registeredImporters' in error.detail
        ? { registeredImporters: error.detail.registeredImporters }
        : {}),
    };
    return sourcePackageError(code, context, detail);
  }
  return sourcePackageError(contextErrorStage(error), context, {
    stage: 'conversion',
    reason: unknownReason(error),
  });
}

function contextErrorStage(error: unknown): SourcePackageErrorCode {
  return error instanceof SyntaxError
    ? 'source-package-meta-invalid'
    : 'source-package-conversion-failed';
}

function isImportError(error: unknown): error is ImportError {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    'expected' in error &&
    'hint' in error &&
    'detail' in error
  );
}
