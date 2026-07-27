import type {
  AssetRelation,
  CatalogDiagnostic,
  ProviderProvenance,
  ResourceRevision,
  TopologyDiff,
} from './asset-producer';
import type { AssetCompression, ImageMetadata } from './index';

/** One producer revision point in a catalog continuity window. */
export interface CatalogRevisionPoint {
  readonly rootId: string;
  readonly revision: number;
}

/** Baseline/current revision sets used to reject stale or partial updates. */
export interface CatalogRevisionWindow {
  readonly baseline: readonly CatalogRevisionPoint[];
  readonly current: readonly CatalogRevisionPoint[];
}

/**
 * One stable row from a development or build catalog snapshot.
 *
 * `guid` and producer facts are identity-bearing data; `relativeUrl` and
 * `sourcePath` are locators and must not be used as replacement identity.
 */
export interface CatalogEntry {
  readonly guid: string;
  readonly relativeUrl: string;
  readonly kind: string;
  readonly sourcePath: string;
  /** Stable package identity; path is a locator, never the package identity. */
  readonly packageId?: string;
  /** Producer-owned importer/provider identity and version. */
  readonly provenance?: ProviderProvenance;
  /** Producer-owned resource/package revision used for conflict checks. */
  readonly revision?: ResourceRevision;
  /** Stable producer key for imported-output topology matching. */
  readonly sourceKey?: string;
  /** Producer-declared output position; never used as identity when sourceKey exists. */
  readonly sourceIndex?: number;
  /** Typed graph edges emitted by the producer. */
  readonly relations?: readonly AssetRelation[];
  /** Structured producer diagnostics; consumers must not parse messages. */
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly name?: string;
  readonly metadata?: ImageMetadata | undefined;
  readonly refs?: readonly string[];
  readonly compression?: AssetCompression;
}

/**
 * A folded, neutral set of catalog-row changes keyed by stable GUID.
 *
 * `authority` and `diagnostics` tell AI-readable consumers whether the delta
 * is safe to apply; a degraded delta carries no identity-bearing changes.
 */
export interface CatalogDelta {
  readonly added: readonly CatalogEntry[];
  readonly changed: readonly CatalogEntry[];
  readonly removed: readonly CatalogEntry['guid'][];
  /** Optional topology evidence for imported-output changes in this delta. */
  readonly topology?: readonly TopologyDiff[];
  /** Present when a watch revision was supplied for continuity validation. */
  readonly authority?: 'authoritative' | 'degraded';
  /** Machine-readable continuity or topology diagnostics. */
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly revisions?: CatalogRevisionWindow;
}
