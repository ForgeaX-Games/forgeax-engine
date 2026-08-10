import type { DdcPack } from '@forgeax/engine-import';
import {
  type ImporterRegistry,
  type ImportRunnerFs,
  type RunImportMeta,
  type RunImportProductResult,
  runImport,
} from '@forgeax/engine-import';
import type { ImportErrorDetail, ImportedAsset, ImportProduct } from '@forgeax/engine-types';
import { productAssetsByGuid, projectImportProductForBuild } from '../import-products.js';
import type { LogicalPackage } from '../package-finalizer.js';

export type ProducerReadiness = 'before-consume' | 'on-demand';

export interface ProducerReadinessError {
  readonly code: 'producer-readiness-invalid';
  readonly expected: "'before-consume' or 'on-demand'";
  readonly hint: 'set producerReadiness to before-consume or on-demand';
  readonly detail: { readonly value: unknown };
}

export type ProducerReadinessResult =
  | { readonly ok: true; readonly value: ProducerReadiness }
  | { readonly ok: false; readonly error: ProducerReadinessError };

export function parseProducerReadiness(value: unknown): ProducerReadinessResult {
  if (value === undefined || value === 'before-consume' || value === 'on-demand') {
    return { ok: true, value: value ?? 'before-consume' };
  }
  return {
    ok: false,
    error: {
      code: 'producer-readiness-invalid',
      expected: "'before-consume' or 'on-demand'",
      hint: 'set producerReadiness to before-consume or on-demand',
      detail: { value },
    },
  };
}

export interface SourcePackageProducerInput {
  readonly meta: RunImportMeta;
  readonly registry: ImporterRegistry;
  readonly fs: ImportRunnerFs;
}

export interface SourcePackageClosureDetail {
  readonly stage: 'closure';
  readonly declaredGuids: readonly string[];
  readonly producedGuids: readonly string[];
  readonly missingGuids: readonly string[];
  readonly unexpectedGuids: readonly string[];
  readonly duplicateGuids: readonly string[];
}

export interface SourcePackageClosureError {
  readonly code: 'source-package-guid-closure-mismatch';
  readonly expected: string;
  readonly hint: string;
  readonly detail: SourcePackageClosureDetail;
}

export interface SourcePackageProduct {
  readonly anchorGuid: string;
  readonly declaredGuids: readonly string[];
  readonly pack: DdcPack;
  readonly logicalPackage: LogicalPackage;
  readonly product: ImportProduct;
  readonly sourceDependencies: readonly string[];
}

export type SourcePackageProducerResult =
  | { readonly ok: true; readonly value: SourcePackageProduct }
  | { readonly ok: false; readonly error: SourcePackageClosureError };

function closureError(
  declaredGuids: readonly string[],
  producedGuids: readonly string[],
): SourcePackageClosureError {
  const declared = new Set(declaredGuids.map((guid) => guid.toLowerCase()));
  const produced = new Set(producedGuids.map((guid) => guid.toLowerCase()));
  const counts = new Map<string, number>();
  for (const guid of producedGuids) {
    const key = guid.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicateGuids = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([guid]) => guid);
  return {
    code: 'source-package-guid-closure-mismatch',
    expected: 'the importer to return exactly one asset for every declared Meta GUID',
    hint: 'repair the Meta declaration or importer output, then rebuild the whole source package',
    detail: {
      stage: 'closure',
      declaredGuids,
      producedGuids,
      missingGuids: declaredGuids.filter((guid) => !produced.has(guid.toLowerCase())),
      unexpectedGuids: producedGuids.filter((guid) => !declared.has(guid.toLowerCase())),
      duplicateGuids,
    },
  };
}

function sourcePackagePack(
  result: Extract<RunImportProductResult, { readonly ok: true }>,
  meta: RunImportMeta,
): DdcPack {
  if ('skipped' in result.value) {
    return {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [],
    };
  }
  const assets = result.value.product.assets.map((asset) => ({
    guid: asset.guid,
    kind: asset.kind,
    payload: asset.payload as unknown as Record<string, unknown>,
    refs: asset.refs.map((ref) => ref.guid),
    artifacts: asset.artifacts,
  }));
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    ...(meta.packageId === undefined ? {} : { packageId: meta.packageId }),
    assets,
  };
}

function closureGuids(meta: RunImportMeta): readonly string[] {
  return meta.subAssets.map((asset) => asset.guid);
}

function producedGuidsFromImportFailure(
  declaredGuids: readonly string[],
  detail: ImportErrorDetail,
): readonly string[] {
  if ('missingGuids' in detail) {
    return declaredGuids.filter((guid) => !detail.missingGuids.includes(guid));
  }
  if ('unexpectedGuids' in detail) return [...declaredGuids, ...detail.unexpectedGuids];
  return [];
}

export async function produceSourcePackage(
  input: SourcePackageProducerInput,
): Promise<SourcePackageProducerResult> {
  const meta = input.meta;
  const declaredGuids = closureGuids(meta);
  const result = await runImport(meta, input.registry, input.fs);
  if (!result.ok) {
    const producedGuids = producedGuidsFromImportFailure(declaredGuids, result.error.detail);
    return {
      ok: false,
      error: closureError(declaredGuids, producedGuids),
    };
  }
  if ('skipped' in result.value) {
    return { ok: false, error: closureError(declaredGuids, []) };
  }

  const producedGuids = result.value.product.assets.map((asset) => asset.guid);
  const declaredSet = new Set(declaredGuids.map((guid) => guid.toLowerCase()));
  const producedSet = new Set(producedGuids.map((guid) => guid.toLowerCase()));
  const hasDuplicate =
    new Set(producedGuids.map((guid) => guid.toLowerCase())).size !== producedGuids.length;
  const complete =
    !hasDuplicate &&
    declaredGuids.length === producedGuids.length &&
    declaredGuids.every((guid) => producedSet.has(guid.toLowerCase())) &&
    producedGuids.every((guid) => declaredSet.has(guid.toLowerCase()));
  if (!complete) return { ok: false, error: closureError(declaredGuids, producedGuids) };

  const product = result.value.product;
  const logicalPackage = projectImportProductForBuild(product);
  const pack = sourcePackagePack(result, meta);
  const anchorGuid = [...declaredGuids].sort((left, right) => left.localeCompare(right))[0];
  if (anchorGuid === undefined)
    return { ok: false, error: closureError(declaredGuids, producedGuids) };
  return {
    ok: true,
    value: {
      anchorGuid,
      declaredGuids,
      pack,
      logicalPackage,
      product,
      sourceDependencies: product.sourceDependencies,
    },
  };
}

export function sourcePackageAssetsByGuid(
  source: SourcePackageProduct,
): ReadonlyMap<string, ImportedAsset> {
  return productAssetsByGuid(source.product);
}
