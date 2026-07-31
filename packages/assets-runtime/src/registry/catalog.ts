import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  ASSET_ERROR_HINTS,
  type Asset,
  type AssetAuthoringCapability,
  type AssetEnvelope,
  AssetError,
  type AssetRelation,
  authoringCapabilityForAssetKind,
  type CatalogDiagnostic,
  type ProviderProvenance,
  type ResourceRevision,
} from '@forgeax/engine-types';
import type { AssetRegistry } from '../asset-registry';

/** Runtime catalog row parsed from the shared pack-index POD shape. */
export interface CatalogRecord {
  readonly packageUrl: string;
  readonly kind: string;
  readonly authoring?: import('@forgeax/engine-types').AssetAuthoringCapability;
  readonly name?: string;
  readonly refs?: readonly string[];
  readonly sourcePath?: string;
  readonly cookReceiptUrl?: string;
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
    packageUrl: '',
    kind: envelope.payload.kind,
    authoring: authoringCapabilityForAssetKind(envelope.payload.kind),
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
export function resolveCatalogAssetUrl(registry: AssetRegistry, packageUrl: string): string {
  const packIndexUrl = registry.packIndexUrl;
  if (packIndexUrl === undefined) return packageUrl;

  try {
    const baseUrl = new URL(packIndexUrl, globalThis.location?.href).href;
    return new URL(packageUrl, baseUrl).href;
  } catch {
    return packageUrl;
  }
}

function isRawSourceLocator(packageUrl: string): boolean {
  const path = packageUrl.split(/[?#]/, 1)[0]?.toLowerCase() ?? packageUrl.toLowerCase();
  if (path.endsWith('.pack.json')) return false;
  return /\.(bin|fbx|gltf|glb|hdr|jpg|jpeg|png|wav|mp3|ogg|ttf|otf|woff|woff2|svg)$/.test(path);
}

/** Parse the shared pack-index/catalog wire shape without loading payloads. */
export function parseCatalog(
  raw: unknown,
  resolveUrl: (packageUrl: string) => string = (packageUrl) => packageUrl,
  expectedRevision?: ResourceRevision,
): Result<Map<string, CatalogRecord>, AssetError> {
  if (!Array.isArray(raw)) {
    return err(parseError('pack-index.json to be a JSON array'));
  }

  const catalog = new Map<string, CatalogRecord>();
  for (const item of raw) {
    if (item === null || typeof item !== 'object') {
      return err(parseError('each catalog row to be an object'));
    }
    const rawRow = item as Record<string, unknown>;
    const legacyLocator = ['relative', 'Url'].join('');
    if (
      legacyLocator in rawRow ||
      'metadata' in rawRow ||
      'compression' in rawRow ||
      'artifacts' in rawRow ||
      'assetCodec' in rawRow ||
      'contentEncoding' in rawRow
    ) {
      return err(parseError('catalog rows to expose navigation fields only'));
    }
    if (
      typeof rawRow.guid !== 'string' ||
      rawRow.guid.length === 0 ||
      typeof rawRow.packageUrl !== 'string' ||
      rawRow.packageUrl.length === 0 ||
      typeof rawRow.kind !== 'string' ||
      rawRow.kind.length === 0
    ) {
      return err(parseError('each catalog row to contain guid, packageUrl, and kind strings'));
    }
    if (isRawSourceLocator(rawRow.packageUrl)) {
      return err(
        parseError(`catalog packageUrl ${rawRow.packageUrl} to identify a cooked package`),
      );
    }
    const guid = rawRow.guid.toLowerCase();
    if (catalog.has(guid)) return err(parseError(`catalog GUID ${rawRow.guid} to be unique`));
    const refs = rawRow.refs;
    if (
      refs !== undefined &&
      (!Array.isArray(refs) || !refs.every((ref) => typeof ref === 'string'))
    ) {
      return err(parseError(`catalog refs for GUID ${rawRow.guid} to be a string array`));
    }
    let resolvedUrl: string;
    try {
      resolvedUrl = resolveUrl(rawRow.packageUrl);
    } catch (error) {
      return err(
        parseError(`catalog entry ${rawRow.guid} to resolve its packageUrl`, {
          packageUrl: rawRow.packageUrl,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    const row: CatalogRecord = {
      packageUrl: resolvedUrl,
      kind: rawRow.kind,
      ...(rawRow.authoring !== undefined
        ? { authoring: rawRow.authoring as AssetAuthoringCapability }
        : {}),
      ...(typeof rawRow.name === 'string' ? { name: rawRow.name } : {}),
      ...(typeof rawRow.sourcePath === 'string' ? { sourcePath: rawRow.sourcePath } : {}),
      ...(refs !== undefined ? { refs: refs as readonly string[] } : {}),
      ...(typeof rawRow.cookReceiptUrl === 'string'
        ? { cookReceiptUrl: rawRow.cookReceiptUrl }
        : {}),
      ...(typeof rawRow.packageId === 'string' ? { packageId: rawRow.packageId } : {}),
      ...(rawRow.provenance !== undefined
        ? { provenance: rawRow.provenance as ProviderProvenance }
        : {}),
      ...(rawRow.revision !== undefined ? { revision: rawRow.revision as ResourceRevision } : {}),
      ...(typeof rawRow.sourceKey === 'string' ? { sourceKey: rawRow.sourceKey } : {}),
      ...(typeof rawRow.sourceIndex === 'number' ? { sourceIndex: rawRow.sourceIndex } : {}),
      ...(Array.isArray(rawRow.relations)
        ? { relations: rawRow.relations as readonly AssetRelation[] }
        : {}),
      ...(Array.isArray(rawRow.diagnostics)
        ? { diagnostics: rawRow.diagnostics as readonly CatalogDiagnostic[] }
        : {}),
    };
    catalog.set(guid, row);
  }
  const revisionError = checkExpectedRevision([...catalog.values()], expectedRevision);
  if (revisionError !== undefined) return err(revisionError);
  return ok(catalog);
}

/** Fetch and parse a catalog using the shared JSON/error boundary. */
export async function fetchCatalog(
  url: string,
  fetch: CatalogFetch,
  resolveUrl?: (packageUrl: string) => string,
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
  return fetchCatalog(registry.packIndexUrl as string, globalThis.fetch, (packageUrl) =>
    resolveCatalogAssetUrl(registry, packageUrl),
  );
}
