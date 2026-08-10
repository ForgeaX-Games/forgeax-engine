import {
  type CatalogDiagnostic,
  catalogOperationsFor,
  type PackIndexEntry,
} from '@forgeax/engine-types';
import {
  canonicalizeLogicalPackage,
  type FinalizedPackage,
  type FinalizePolicy,
  finalizePackage,
  type LogicalPackage,
  type PackageSink,
} from '../package-finalizer.js';
import type { SourcePackageError } from '../producer/source-package-errors.js';
import {
  publishSourcePackage,
  type SourcePackagePublicationInput,
  type SourcePackagePublicationResult,
} from '../producer/source-package-publication.js';

export function projectSourcePackageFailure(
  rows: readonly PackIndexEntry[],
  error: SourcePackageError,
): PackIndexEntry[] {
  const affected = new Set(error.detail.affectedGuids.map((guid) => guid.toLowerCase()));
  const diagnostic: CatalogDiagnostic = {
    code: error.code,
    severity: 'blocking',
    authority: 'producer',
    expected: error.expected,
    ...(error.detail.reason === undefined ? {} : { actual: error.detail.reason }),
    hint: error.hint,
    evidence: [...affected].map((guid) => ({ type: 'asset', id: guid })),
    recoveryIntents: [error.hint],
  };
  return rows.map((row) => {
    if (!affected.has(row.guid.toLowerCase())) return row;
    const subject = row.subject ?? 'imported-output';
    const execution = row.execution ?? 'cooked';
    const lifecycle = 'failed' as const;
    return {
      ...row,
      lifecycle,
      diagnostics: [...(row.diagnostics ?? []), diagnostic],
      projection: {
        subject,
        execution,
        lifecycle,
        operations: catalogOperationsFor({ subject, execution, lifecycle }),
        ...(row.projection?.lastKnownGood === undefined
          ? {}
          : { lastKnownGood: row.projection.lastKnownGood }),
      },
    };
  });
}

export type PackageSourceInput =
  | { readonly origin: 'authoredPack'; readonly logicalPackage: LogicalPackage }
  | {
      readonly origin: 'sourceMeta';
      readonly cooked: boolean;
      readonly logicalPackage: LogicalPackage;
    };

export interface PackageRouteError {
  readonly code: 'source-meta-not-cooked';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly origin: 'sourceMeta' };
}

export type PackageSourceResult =
  | { readonly ok: true; readonly value: PackageSourceInput }
  | { readonly ok: false; readonly error: PackageRouteError };

export function resolvePackageSource(input: PackageSourceInput): PackageSourceResult {
  if (input.origin === 'sourceMeta' && !input.cooked) {
    return {
      ok: false,
      error: {
        code: 'source-meta-not-cooked',
        expected: 'source meta to complete semantic import and cook before delivery',
        hint: 'Run the source importer and cook the logical package before finalization.',
        detail: { origin: 'sourceMeta' },
      },
    };
  }
  return { ok: true, value: input };
}

export interface PublishedPackage extends FinalizedPackage {
  readonly origin: PackageSourceInput['origin'];
  readonly cacheHit: boolean;
}

export function createPackageRoutes() {
  const published = new Map<string, PublishedPackage>();

  return {
    async publish(
      input: PackageSourceInput,
      sink: PackageSink,
      policy: FinalizePolicy,
    ): Promise<
      | { readonly ok: true; readonly value: PublishedPackage }
      | { readonly ok: false; readonly error: PackageRouteError }
    > {
      const resolved = resolvePackageSource(input);
      if (!resolved.ok) return resolved;
      const key = `${canonicalizeLogicalPackage(input.logicalPackage)}\0${policy.base}\0${policy.packagePath}`;
      const existing = published.get(key);
      if (existing !== undefined) return { ok: true, value: { ...existing, cacheHit: true } };
      const finalized = await finalizePackage(input.logicalPackage, sink, policy);
      const value: PublishedPackage = { ...finalized, origin: input.origin, cacheHit: false };
      published.set(key, value);
      return { ok: true, value };
    },
    invalidate(): void {
      published.clear();
    },
  };
}

/** Route source packages through the same staged, verified publication owner. */
export function publishSourcePackageRoute(
  input: SourcePackagePublicationInput,
): Promise<SourcePackagePublicationResult> {
  return publishSourcePackage(input);
}
