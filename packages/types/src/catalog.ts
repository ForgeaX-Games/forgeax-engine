import type { AssetCompression, ImageMetadata } from './index';

/** One stable row from a development or build catalog snapshot. */
export interface CatalogEntry {
  readonly guid: string;
  readonly relativeUrl: string;
  readonly kind: string;
  readonly sourcePath: string;
  readonly name?: string;
  readonly metadata?: ImageMetadata | undefined;
  readonly refs?: readonly string[];
  readonly compression?: AssetCompression;
}

/** A folded, neutral set of catalog-row changes keyed by stable GUID. */
export interface CatalogDelta {
  readonly added: readonly CatalogEntry[];
  readonly changed: readonly CatalogEntry[];
  readonly removed: readonly CatalogEntry['guid'][];
}
