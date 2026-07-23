import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  ASSET_ERROR_HINTS,
  type AssetCompression,
  AssetError,
  type ImageMetadata,
} from '@forgeax/engine-types';
import type { AssetRegistry } from '../asset-registry';

export interface CatalogRecord {
  readonly relativeUrl: string;
  readonly kind: string;
  readonly name?: string;
  readonly metadata?: ImageMetadata | undefined;
  readonly refs?: readonly string[];
  readonly compression?: AssetCompression;
  readonly sourcePath?: string;
}

type CatalogFetch = (input: string) => PromiseLike<{
  readonly ok: boolean;
  json(): Promise<unknown>;
}>;

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

/** Parse the shared pack-index/catalog wire shape without loading payloads. */
export function parseCatalog(
  raw: unknown,
  resolveUrl: (relativeUrl: string) => string = (relativeUrl) => relativeUrl,
): Result<Map<string, CatalogRecord>, AssetError> {
  if (!Array.isArray(raw)) {
    return err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: 'pack-index.json to be a JSON array',
        hint: ASSET_ERROR_HINTS['asset-parse-failed'],
      }),
    );
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
  }>) {
    if (
      typeof item.guid !== 'string' ||
      typeof item.relativeUrl !== 'string' ||
      typeof item.kind !== 'string'
    ) {
      continue;
    }

    const compression =
      item.compression === 'none' ||
      item.compression === 'zstd' ||
      item.compression === 'basis-etc1s' ||
      item.compression === 'basis-uastc' ||
      item.compression === 'basis-uastc-hdr'
        ? item.compression
        : undefined;
    const row: CatalogRecord = {
      relativeUrl: resolveUrl(item.relativeUrl),
      kind: item.kind,
      metadata: item.metadata as ImageMetadata | undefined,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.sourcePath === 'string' ? { sourcePath: item.sourcePath } : {}),
      ...(Array.isArray(item.refs) && item.refs.every((ref) => typeof ref === 'string')
        ? { refs: item.refs as readonly string[] }
        : {}),
      ...(compression !== undefined ? { compression } : {}),
    };
    catalog.set(item.guid.toLowerCase(), row);
  }
  return ok(catalog);
}

/** Fetch and parse a catalog using the shared JSON/error boundary. */
export async function fetchCatalog(
  url: string,
  fetch: CatalogFetch,
  resolveUrl?: (relativeUrl: string) => string,
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
  return parseCatalog(raw, resolveUrl);
}

export function fetchPackIndex(
  registry: AssetRegistry,
): Promise<Result<Map<string, CatalogRecord>, AssetError>> {
  return fetchCatalog(registry.packIndexUrl as string, globalThis.fetch, (relativeUrl) =>
    resolveCatalogAssetUrl(registry, relativeUrl),
  );
}
