import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  type CatalogDelta,
  type CatalogEntry,
  type ResourceRevision,
  type RuntimeAssetBinding,
  validateCatalogDelta,
} from '@forgeax/engine-types';
import { fetchCatalog, resolveCatalogAssetUrl } from './registry/catalog';

export type CatalogListener = (delta: CatalogDelta) => void;

/** Read-only catalog source backed by static entries or a canonical URL. */
export interface CatalogSource {
  enumerate(): Promise<Result<readonly CatalogEntry[], AssetError>>;
  subscribe(listener: CatalogListener): () => void;
  /** Bind one immutable publication through Pack, artifacts and decode. The closure owns its bytes. */
  openPackage?(packageUrl: string): typeof globalThis.fetch | undefined;
  /** Same-domain immutable data; ordinary Registry domain/reference checks still apply. */
  /** Canonical transport authority when this source is URL-backed. */
  readonly url?: string;
  /** Producer revision required before a source may expose its entries. */
  readonly expectedRevision?: ResourceRevision;
  readonly expectedScope?: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'>;
}

/**
 * Create a read-only catalog source while preserving the schema SSOT.
 *
 * Static and fetched sources use the same `CatalogEntry` and revision fields;
 * an expected revision rejects unverified data before it reaches consumers.
 */
export function createCatalogSource(options: {
  readonly url?: string;
  readonly entries?: readonly CatalogEntry[];
  readonly fetch?: typeof globalThis.fetch;
  readonly expectedRevision?: ResourceRevision;
  readonly expectedScope?: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'>;
  readonly subscribe?: (listener: CatalogListener) => () => void;
}): CatalogSource {
  const entries = options.entries;
  let pending: ReturnType<CatalogSource['enumerate']> | undefined;
  return {
    async enumerate() {
      if (entries !== undefined) {
        if (options.expectedRevision === undefined) return ok(entries);
        const actualRevisions = entries.flatMap((entry) =>
          entry.revision === undefined ? [] : [entry.revision],
        );
        const matches =
          actualRevisions.length > 0 &&
          actualRevisions.every(
            (revision) =>
              revision.digest === options.expectedRevision?.digest &&
              revision.observedAt === options.expectedRevision?.observedAt &&
              revision.rootId === options.expectedRevision?.rootId,
          );
        if (!matches) {
          return err(
            new AssetError({
              code: 'asset-parse-failed',
              expected: 'static catalog entries to carry the expected producer revision',
              hint: 'restore a verified catalog revision before applying the source',
              detail: { expectedRevision: options.expectedRevision, actualRevisions } as never,
            }),
          );
        }
        return ok(entries);
      }
      if (options.url === undefined) {
        return err(
          new AssetError({
            code: 'catalog-source-unconfigured',
            expected: 'a configured catalog source',
            hint: ASSET_ERROR_HINTS['catalog-source-unconfigured'],
          }),
        );
      }
      if (pending !== undefined) return pending;
      const url = options.url;
      const fetcher = options.fetch ?? globalThis.fetch;
      const expectedRevision = options.expectedRevision;
      const expectedScope = options.expectedScope;
      const read = Promise.resolve().then(async () => {
        const result = await fetchCatalog(
          url,
          fetcher,
          (packageUrl) => resolveCatalogAssetUrl({ packIndexUrl: options.url }, packageUrl),
          expectedRevision,
          expectedScope,
        );
        if (!result.ok) return result;
        return ok(
          [...result.value].map(([guid, entry]) => ({ guid, ...entry })) as readonly CatalogEntry[],
        );
      });
      pending = read;
      const release = () => {
        if (pending === read) pending = undefined;
      };
      void read.then(release, release);
      return read;
    },
    subscribe(listener) {
      return (
        options.subscribe?.((delta) => {
          pending = undefined;
          listener(delta);
        }) ?? (() => {})
      );
    },
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(options.expectedRevision === undefined
      ? {}
      : { expectedRevision: options.expectedRevision }),
    ...(options.expectedScope === undefined ? {} : { expectedScope: options.expectedScope }),
  };
}

export interface CatalogHotChannel {
  on(event: string, listener: (data: unknown) => void): void;
  off(event: string, listener: (data: unknown) => void): void;
}

/** Fold `forgeax:catalog-delta` into an open catalog source. Invalid deltas leave the replica unchanged. */
export function createCatalogHotSubscription(
  hot: CatalogHotChannel | undefined,
): (listener: CatalogListener) => () => void {
  return (listener) => {
    if (hot === undefined) return () => {};
    const onDelta = (data: unknown): void => {
      const validation = validateCatalogDelta(data);
      if (!validation.ok) return;
      listener(validation.value);
    };
    hot.on('forgeax:catalog-delta', onDelta);
    return () => hot.off('forgeax:catalog-delta', onDelta);
  };
}
