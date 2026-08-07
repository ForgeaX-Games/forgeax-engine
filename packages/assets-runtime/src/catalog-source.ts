import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  type CatalogDelta,
  type CatalogEntry,
  type ResourceRevision,
  type RuntimeAssetBinding,
} from '@forgeax/engine-types';
import { fetchCatalog } from './registry/catalog';

export type CatalogListener = (delta: CatalogDelta) => void;

/** Read-only catalog source backed by static entries or a canonical URL. */
export interface CatalogSource {
  enumerate(): Promise<Result<readonly CatalogEntry[], AssetError>>;
  subscribe(listener: CatalogListener): () => void;
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
      const result = await fetchCatalog(
        options.url,
        options.fetch ?? globalThis.fetch,
        undefined,
        options.expectedRevision,
        options.expectedScope,
      );
      if (!result.ok) return result;
      return ok(
        [...result.value].map(([guid, entry]) => ({ guid, ...entry })) as readonly CatalogEntry[],
      );
    },
    subscribe(listener) {
      return options.subscribe?.(listener) ?? (() => {});
    },
    ...(options.expectedScope === undefined ? {} : { expectedScope: options.expectedScope }),
  };
}
