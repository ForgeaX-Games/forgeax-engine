import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  type CatalogDelta,
  type CatalogEntry,
} from '@forgeax/engine-types';
import { fetchCatalog } from './registry/catalog';

export type CatalogListener = (delta: CatalogDelta) => void;

export interface CatalogSource {
  enumerate(): Promise<Result<readonly CatalogEntry[], AssetError>>;
  subscribe(listener: CatalogListener): () => void;
}

export function createCatalogSource(options: {
  readonly url?: string;
  readonly entries?: readonly CatalogEntry[];
  readonly fetch?: typeof globalThis.fetch;
  readonly subscribe?: (listener: CatalogListener) => () => void;
}): CatalogSource {
  const entries = options.entries;
  return {
    async enumerate() {
      if (entries !== undefined) return ok(entries);
      if (options.url === undefined) {
        return err(
          new AssetError({
            code: 'catalog-source-unconfigured',
            expected: 'a configured catalog source',
            hint: ASSET_ERROR_HINTS['catalog-source-unconfigured'],
          }),
        );
      }
      const result = await fetchCatalog(options.url, options.fetch ?? globalThis.fetch);
      if (!result.ok) return result;
      return ok(
        [...result.value].map(([guid, entry]) => ({ guid, ...entry })) as readonly CatalogEntry[],
      );
    },
    subscribe(listener) {
      return options.subscribe?.(listener) ?? (() => {});
    },
  };
}
