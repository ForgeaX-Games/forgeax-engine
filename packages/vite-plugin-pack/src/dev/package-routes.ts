import {
  canonicalizeLogicalPackage,
  type FinalizedPackage,
  type FinalizePolicy,
  finalizePackage,
  type LogicalPackage,
  type PackageSink,
} from '../package-finalizer.js';

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
