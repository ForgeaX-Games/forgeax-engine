import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  ASSET_ERROR_HINTS,
  type Asset,
  type AssetCompression,
  type AssetEnvelope,
  AssetError,
  type AssetRelation,
  type CatalogDiagnostic,
  type ImageMetadata,
  type ProviderProvenance,
  type ResourceRevision,
} from '@forgeax/engine-types';
import type { AssetRegistry } from '../asset-registry';

/** Runtime catalog row parsed from the shared pack-index POD shape. */
export interface CatalogRecord {
  readonly relativeUrl: string;
  readonly kind: string;
  readonly name?: string;
  readonly metadata?: ImageMetadata | undefined;
  readonly refs?: readonly string[];
  readonly compression?: AssetCompression;
  readonly sourcePath?: string;
  readonly packageId?: string;
  readonly provenance?: ProviderProvenance;
  readonly revision?: ResourceRevision;
  readonly sourceKey?: string;
  readonly sourceIndex?: number;
  readonly relations?: readonly AssetRelation[];
  readonly diagnostics?: readonly CatalogDiagnostic[];
}

/** Build the canonical row for an inline asset without inventing producer facts. */
export function createInlineCatalogRecord(
  envelope: AssetEnvelope<Asset>,
  name: string,
): CatalogRecord {
  return {
    relativeUrl: '',
    kind: envelope.payload.kind,
    name,
    ...(envelope.refs.length > 0 ? { refs: envelope.refs.map((ref) => ref.guid) } : {}),
  };
}

type CatalogFetch = (input: string) => PromiseLike<{
  readonly ok: boolean;
  json(): Promise<unknown>;
}>;

function parseError(
  expected: string,
  detail?: object,
  hint = ASSET_ERROR_HINTS['asset-parse-failed'],
): AssetError {
  return new AssetError({
    code: 'asset-parse-failed',
    expected,
    hint,
    ...(detail === undefined ? {} : { detail: detail as never }),
  });
}

function sameRevision(left: ResourceRevision, right: ResourceRevision): boolean {
  return (
    left.digest === right.digest &&
    left.observedAt === right.observedAt &&
    left.rootId === right.rootId
  );
}

function checkExpectedRevision(
  records: readonly CatalogRecord[],
  expectedRevision: ResourceRevision | undefined,
): AssetError | undefined {
  if (expectedRevision === undefined || records.length === 0) return undefined;
  const actualRevisions = records.flatMap((record) =>
    record.revision === undefined ? [] : [record.revision],
  );
  if (
    actualRevisions.length > 0 &&
    actualRevisions.every((revision) => sameRevision(revision, expectedRevision))
  ) {
    return undefined;
  }
  return parseError(
    'every catalog entry to carry the expected producer revision',
    { expectedRevision, actualRevisions },
    'restore a verified catalog revision before applying the source',
  );
}

/** Resolve a catalog entry URL against the configured pack-index URL. */
export function resolveCatalogAssetUrl(registry: AssetRegistry, relativeUrl: string): string {
  const packIndexUrl = registry.packIndexUrl;
  if (packIndexUrl === undefined) return relativeUrl;

  try {
    const baseUrl = new URL(packIndexUrl, globalThis.location?.href).href;
    return new URL(relativeUrl, baseUrl).href;
  } catch {
    return relativeUrl;
  }
}

/**
 * Parse the shared pack-index/catalog wire shape without loading payloads.
 *
 * The returned map is keyed by normalized GUID; all producer facts and
 * structured diagnostics remain data for AI-readable callers.
 */
export function parseCatalog(
  raw: unknown,
  resolveUrl: (relativeUrl: string) => string = (relativeUrl) => relativeUrl,
  expectedRevision?: ResourceRevision,
): Result<Map<string, CatalogRecord>, AssetError> {
  if (!Array.isArray(raw)) {
    return err(parseError('pack-index.json to be a JSON array'));
  }

  const catalog = new Map<string, CatalogRecord>();
  for (const item of raw as Array<{
    guid?: unknown;
    relativeUrl?: unknown;
    kind?: unknown;
    name?: unknown;
    metadata?: unknown;
    refs?: unknown;
    compression?: unknown;
    sourcePath?: unknown;
    packageId?: unknown;
    provenance?: unknown;
    revision?: unknown;
    sourceKey?: unknown;
    sourceIndex?: unknown;
    relations?: unknown;
    diagnostics?: unknown;
  }>) {
    if (typeof item.guid !== 'string' || item.guid.length === 0) {
      return err(parseError('each catalog entry to contain a non-empty guid'));
    }
    if (typeof item.relativeUrl !== 'string' || item.relativeUrl.length === 0) {
      return err(parseError(`catalog entry ${item.guid} to contain a non-empty relativeUrl`));
    }
    if (typeof item.kind !== 'string' || item.kind.length === 0) {
      return err(parseError(`catalog entry ${item.guid} to contain a non-empty kind`));
    }

    const compression =
      item.compression === 'none' ||
      item.compression === 'zstd' ||
      item.compression === 'basis-etc1s' ||
      item.compression === 'basis-uastc' ||
      item.compression === 'basis-uastc-hdr'
        ? item.compression
        : undefined;
    let resolvedUrl: string;
    try {
      resolvedUrl = resolveUrl(item.relativeUrl);
    } catch (error) {
      return err(
        parseError(`catalog entry ${item.guid} to resolve its relativeUrl`, {
          relativeUrl: item.relativeUrl,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    const row: CatalogRecord = {
      relativeUrl: resolvedUrl,
      kind: item.kind,
      metadata: item.metadata as ImageMetadata | undefined,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.sourcePath === 'string' ? { sourcePath: item.sourcePath } : {}),
      ...(Array.isArray(item.refs) && item.refs.every((ref) => typeof ref === 'string')
        ? { refs: item.refs as readonly string[] }
        : {}),
      ...(compression !== undefined ? { compression } : {}),
      ...(typeof item.packageId === 'string' ? { packageId: item.packageId } : {}),
      ...(item.provenance !== undefined
        ? { provenance: item.provenance as ProviderProvenance }
        : {}),
      ...(item.revision !== undefined ? { revision: item.revision as ResourceRevision } : {}),
      ...(typeof item.sourceKey === 'string' ? { sourceKey: item.sourceKey } : {}),
      ...(typeof item.sourceIndex === 'number' ? { sourceIndex: item.sourceIndex } : {}),
      ...(Array.isArray(item.relations)
        ? { relations: item.relations as readonly AssetRelation[] }
        : {}),
      ...(Array.isArray(item.diagnostics)
        ? { diagnostics: item.diagnostics as readonly CatalogDiagnostic[] }
        : {}),
    };
    catalog.set(item.guid.toLowerCase(), row);
  }
  const revisionError = checkExpectedRevision([...catalog.values()], expectedRevision);
  if (revisionError !== undefined) return err(revisionError);
  return ok(catalog);
}

/** Fetch and parse a catalog using the shared JSON/error boundary. */
export async function fetchCatalog(
  url: string,
  fetch: CatalogFetch,
  resolveUrl?: (relativeUrl: string) => string,
  expectedRevision?: ResourceRevision,
): Promise<Result<Map<string, CatalogRecord>, AssetError>> {
  let raw: unknown;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return err(
        new AssetError({
          code: 'asset-fetch-failed',
          expected: `fetch(${url}) to return ok`,
          hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
        }),
      );
    }
    raw = await response.json();
  } catch {
    return err(
      new AssetError({
        code: 'asset-fetch-failed',
        expected: `fetch(${url}) to succeed`,
        hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
      }),
    );
  }
  return parseCatalog(raw, resolveUrl, expectedRevision);
}

export function fetchPackIndex(
  registry: AssetRegistry,
): Promise<Result<Map<string, CatalogRecord>, AssetError>> {
  return fetchCatalog(registry.packIndexUrl as string, globalThis.fetch, (relativeUrl) =>
    resolveCatalogAssetUrl(registry, relativeUrl),
  );
}
