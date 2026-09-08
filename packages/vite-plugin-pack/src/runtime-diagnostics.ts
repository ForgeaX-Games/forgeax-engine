import type { CatalogDiagnostic } from '@forgeax/engine-types';

type RuntimeDiagnosticInput = Omit<CatalogDiagnostic, 'severity'> & {
  readonly message: string;
};

export function projectRuntimeDiagnostics(
  diagnostics: readonly RuntimeDiagnosticInput[],
): readonly CatalogDiagnostic[] {
  return diagnostics.map(({ code, message, expected, actual, hint }) => ({
    code,
    severity: 'blocking' as const,
    message,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
    ...(hint === undefined ? {} : { hint }),
  }));
}
