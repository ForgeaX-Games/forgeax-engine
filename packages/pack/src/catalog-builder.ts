import { relative } from 'node:path';
import type { PackIndexEntry, ProviderProvenance } from '@forgeax/engine-types';
import {
  findReservedAssetKindConflict,
  projectExternalCatalogEntries,
  projectPackageCatalog,
} from './catalog-projection.js';
import { loadAssetConfig } from './config.js';
import { deriveAssetName } from './deriveAssetName.js';
import { resolveAssetSource } from './resolve-asset-source.js';
import {
  type MetaInventoryDocument,
  type ScanOptions,
  type ScanSourceDeclaration,
  scanInventory,
} from './scanner.js';

type CatalogImportMeta = Pick<
  MetaInventoryDocument,
  | 'importer'
  | 'packageId'
  | 'provenance'
  | 'revision'
  | 'diagnostics'
  | 'importSettings'
  | 'sourceOverrides'
  | 'subAssets'
> & {
  readonly source: string;
  readonly sourceRevision?: string;
  readonly buildPack?: boolean;
};

export type CatalogBuildErrorCode =
  | 'catalog-meta-schema-invalid'
  | 'catalog-scan-failed'
  | 'catalog-raw-source-unsupported'
  | 'catalog-scriptable-pack-invalid'
  | 'catalog-host-kind-conflict';

export interface CatalogBuildError {
  readonly code: CatalogBuildErrorCode;
  readonly path: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly hint?: string;
  readonly subjects?: readonly string[];
}

export type CatalogAuthority = 'authoritative' | 'degraded';

export interface CatalogBuildResult {
  readonly schemaVersion: 'catalog-legacy-v1';
  readonly entries: readonly PackIndexEntry[];
  readonly authority: CatalogAuthority;
  readonly diagnostics: readonly CatalogBuildError[];
  readonly declarations: ReadonlyMap<string, CatalogImportMeta>;
  readonly sourceDeclarations: ReadonlyMap<string, ScanSourceDeclaration>;
}

export type CatalogProducerVisibility = (
  input: Pick<MetaInventoryDocument, 'importer' | 'importSettings' | 'subAssets'>,
) => boolean;

export interface CatalogImporterPolicy {
  readonly disposition: 'publish' | 'exclude' | 'missing';
  readonly expected: string;
  readonly hint: string;
  readonly hostProvided: boolean;
}

export interface CatalogBuildProjectionOptions {
  readonly base?: string;
  readonly scanOptions?: ScanOptions;
  readonly importerPolicy: (importer: string) => CatalogImporterPolicy;
  readonly visibility?: CatalogProducerVisibility;
}

function sourcePathFor(cwd: string, path: string): string {
  return relative(cwd, path).replace(/\\/g, '/');
}

export function metaPathForGuid(
  declarations: ReadonlyMap<string, CatalogImportMeta>,
  guid: string,
): string | undefined {
  const lower = guid.toLowerCase();
  for (const [path, declaration] of declarations) {
    if (declaration.subAssets.some((asset) => asset.guid.toLowerCase() === lower)) return path;
  }
  return undefined;
}

function unsupportedPolicyError(
  path: string,
  importer: string,
  policy: CatalogImporterPolicy,
): CatalogBuildError {
  return {
    code: 'catalog-raw-source-unsupported',
    path,
    message: `sidecar provider ${JSON.stringify(importer)} cannot publish a Catalog product`,
    expected: policy.expected,
    actual: importer,
    hint: policy.hint,
    subjects: [path],
  };
}

function projectMeta(
  rawPath: string,
  cwd: string,
  base: string,
  assetPaths: Record<string, string>,
  importerPolicy: (importer: string) => CatalogImporterPolicy,
  sourceDeclaration: Extract<ScanSourceDeclaration, { readonly format: 'meta.json' }>,
): {
  readonly entries: PackIndexEntry[];
  readonly declaration?: CatalogImportMeta;
  readonly error?: CatalogBuildError;
} {
  const meta = sourceDeclaration.value;
  const policy = importerPolicy(meta.importer);
  if (policy.disposition !== 'publish') {
    return { entries: [], error: unsupportedPolicyError(rawPath, meta.importer, policy) };
  }
  const resolved = resolveAssetSource(rawPath, meta.source, assetPaths);
  if (!resolved.ok) {
    return {
      entries: [],
      error: {
        code: 'catalog-meta-schema-invalid',
        path: rawPath,
        message: `source resolution failed: ${resolved.error.code} - ${resolved.error.hint}`,
      },
    };
  }
  const sourcePath = sourcePathFor(cwd, resolved.value);
  const packageUrl = `${base}/__forgeax-ddc/${meta.subAssets[0]?.guid?.toLowerCase() ?? 'pack'}.pack.json`;
  const declaration: CatalogImportMeta = {
    importer: meta.importer,
    source: resolved.value,
    sourceRevision: sourceDeclaration.sourceRevision,
    ...(meta.packageId === undefined ? {} : { packageId: meta.packageId }),
    ...(meta.provenance === undefined ? {} : { provenance: meta.provenance }),
    ...(meta.revision === undefined ? {} : { revision: meta.revision }),
    ...(meta.diagnostics === undefined ? {} : { diagnostics: meta.diagnostics }),
    importSettings: meta.importSettings,
    ...(meta.sourceOverrides === undefined ? {} : { sourceOverrides: meta.sourceOverrides }),
    subAssets: meta.subAssets,
  };
  if (policy.hostProvided) {
    const conflict = findReservedAssetKindConflict(meta.subAssets);
    if (conflict !== undefined) {
      return {
        entries: [],
        error: {
          code: 'catalog-host-kind-conflict',
          path: rawPath,
          message: `registered provider ${JSON.stringify(meta.importer)} declares reserved asset kind ${JSON.stringify(conflict.kind)}`,
          expected: 'host provider kinds must not use engine-owned Pack kinds',
          actual: conflict.kind,
          hint: 'rename the provider kind to a provider-owned namespace before rebuilding',
          subjects: [rawPath],
        },
      };
    }
  }
  return {
    declaration,
    entries: projectExternalCatalogEntries(meta, sourcePath, packageUrl, meta.subAssets, (output) =>
      deriveAssetName(resolved.value, meta.subAssets.length, output.name),
    ),
  };
}

function projectSource(
  path: string,
  cwd: string,
  base: string,
  assetPaths: Record<string, string>,
  importerPolicy: (importer: string) => CatalogImporterPolicy,
  visibility: CatalogBuildProjectionOptions['visibility'],
  sourceDeclaration: ScanSourceDeclaration,
  declarations: Map<string, CatalogImportMeta>,
): { readonly entries: PackIndexEntry[]; readonly error?: CatalogBuildError } {
  if (sourceDeclaration.format === 'pack.ts') {
    const meta = { ...sourceDeclaration.meta, source: sourcePathFor(cwd, path) };
    const anchorGuid = meta.subAssets.map((asset) => asset.guid.toLowerCase()).sort()[0];
    return anchorGuid === undefined
      ? { entries: [] }
      : {
          entries: projectExternalCatalogEntries(
            meta,
            sourcePathFor(cwd, path),
            `${base}/__forgeax-ddc/${anchorGuid}.pack.json`,
            meta.subAssets,
            (output) => deriveAssetName(path, meta.subAssets.length, output.name),
          ),
        };
  }
  if (sourceDeclaration.format === 'meta.json') {
    const policy = importerPolicy(sourceDeclaration.value.importer);
    if (
      policy.disposition === 'publish' &&
      visibility?.({
        importer: sourceDeclaration.value.importer,
        importSettings: sourceDeclaration.value.importSettings,
        subAssets: sourceDeclaration.value.subAssets,
      }) === false
    ) {
      return { entries: [] };
    }
    const projected = projectMeta(path, cwd, base, assetPaths, importerPolicy, sourceDeclaration);
    if (projected.declaration !== undefined) declarations.set(path, projected.declaration);
    return projected;
  }
  const parsed = sourceDeclaration.value;
  const sourcePath = sourcePathFor(cwd, path);
  const provenance =
    parsed.provenance ??
    ({ provider: 'pack', version: parsed.schemaVersion } satisfies ProviderProvenance);
  return {
    entries: projectPackageCatalog(
      parsed.assets.map((asset, sourceIndex) => ({
        ...asset,
        sourcePath,
        sourceIndex: asset.sourceIndex ?? sourceIndex,
        ...(parsed.packageId === undefined ? {} : { packageId: parsed.packageId }),
        provenance,
        ...(parsed.revision === undefined ? {} : { revision: parsed.revision }),
        ...(parsed.diagnostics === undefined ? {} : { diagnostics: parsed.diagnostics }),
        name: deriveAssetName(path, parsed.assets.length, asset.name),
      })),
      `${base}/${sourcePath}`,
    ),
  };
}

function warnErrors(errors: readonly CatalogBuildError[]): void {
  for (const error of errors) {
    console.warn(`[forgeax-pack] catalog error ${error.code} @ ${error.path}: ${error.message}`);
  }
}

export async function buildCatalogProjection(
  roots: readonly string[],
  options: CatalogBuildProjectionOptions,
): Promise<CatalogBuildResult> {
  const empty = (
    authority: CatalogAuthority,
    diagnostics: readonly CatalogBuildError[] = [],
  ): CatalogBuildResult => ({
    schemaVersion: 'catalog-legacy-v1',
    entries: [],
    authority,
    diagnostics,
    declarations: new Map(),
    sourceDeclarations: new Map(),
  });
  if (roots.length === 0) return empty('authoritative');
  const cwd = process.cwd();
  const base = (options.base ?? '/').replace(/\/$/, '');
  const scanned = await scanInventory(roots, options.scanOptions);
  if (!scanned.ok) {
    const message =
      scanned.error.detail === undefined
        ? scanned.error.message
        : `${scanned.error.message}; detail=${JSON.stringify(scanned.error.detail)}`;
    const error: CatalogBuildError = {
      code: 'catalog-scan-failed',
      path: '<scan>',
      message,
      expected: 'one inventory scan across all Catalog roots to pass Pack scanning',
      actual: message,
      hint: 'repair the roots before treating any Catalog rows as authoritative',
      subjects: [...roots],
    };
    warnErrors([error]);
    return empty('degraded', [error]);
  }
  const { paths, declarations: sourceDeclarations } = scanned.value;
  const { paths: assetPaths } = loadAssetConfig(cwd);
  const entries: PackIndexEntry[] = [];
  const errors: CatalogBuildError[] = [];
  const declarations = new Map<string, CatalogImportMeta>();
  for (const path of paths) {
    const sourceDeclaration = sourceDeclarations.get(path);
    if (sourceDeclaration === undefined) continue;
    const projected = projectSource(
      path,
      cwd,
      base,
      assetPaths,
      options.importerPolicy,
      options.visibility,
      sourceDeclaration,
      declarations,
    );
    entries.push(...projected.entries);
    if (projected.error !== undefined) errors.push(projected.error);
  }
  warnErrors(errors);
  return {
    schemaVersion: 'catalog-legacy-v1',
    entries,
    authority: errors.length === 0 ? 'authoritative' : 'degraded',
    diagnostics: errors,
    declarations,
    sourceDeclarations,
  };
}
