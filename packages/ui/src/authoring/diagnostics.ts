import type {
  ImportDiagnostic,
  ImportDiagnosticLocation,
  ImportSourceRange,
} from '@forgeax/engine-types';

export type AuthoringDiagnostic = ImportDiagnostic;

export interface AuthoringDiagnosticInput {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly sourcePath: string;
  readonly sourceRange: ImportSourceRange;
  readonly rule: string;
  readonly expected: string;
  readonly actual: string;
  readonly hint: string;
  readonly relatedLocations?: readonly ImportDiagnosticLocation[];
}

export function diagnostic(input: AuthoringDiagnosticInput): AuthoringDiagnostic {
  return {
    code: input.code,
    severity: input.severity,
    sourcePath: input.sourcePath,
    sourceRange: input.sourceRange,
    rule: input.rule,
    expected: input.expected,
    actual: input.actual,
    hint: input.hint,
    ...(input.relatedLocations === undefined ? {} : { relatedLocations: input.relatedLocations }),
  };
}

export function sourceRange(source: string, start: number, end = start + 1): ImportSourceRange {
  const boundedStart = Math.max(0, Math.min(start, source.length));
  const boundedEnd = Math.max(
    boundedStart + 1,
    Math.min(Math.max(end, boundedStart + 1), source.length + 1),
  );
  const prefix = source.slice(0, boundedStart);
  return {
    start: boundedStart,
    end: boundedEnd,
    line: prefix.split('\n').length,
    column: boundedStart - prefix.lastIndexOf('\n'),
  };
}

export function serializeDiagnostics(diagnostics: readonly AuthoringDiagnostic[]): string {
  return JSON.stringify(diagnostics, (_key, value: unknown) => value, 2);
}

export function hasBlockingDiagnostics(diagnostics: readonly AuthoringDiagnostic[]): boolean {
  return diagnostics.some((entry) => entry.severity === 'error');
}
