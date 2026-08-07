import type {
  AssetAuthoringCapability,
  AssetRelation,
  CatalogDiagnostic,
  CatalogLifecycle,
  CatalogProjection,
  CatalogSubject,
  CookExecution,
  ProviderProvenance,
  ResourceRevision,
  SourceOverrideDescriptor,
  SourceOverrideMap,
  TopologyDiff,
} from './asset-producer';

export type {
  CatalogLifecycle,
  CatalogProjection,
  CatalogSubject,
  CookExecution,
} from './asset-producer';

/**
 * Strict contract row for the Catalog projection.
 *
 * This is evidence for an AI consumer, not authoring authority: a Catalog row
 * projects producer facts and runtime navigation while preserving lifecycle,
 * execution, and sourceKey distinctions.
 */
export interface CatalogEntryV2 {
  readonly guid: string;
  readonly packageUrl: string;
  readonly kind: string;
  readonly sourcePath: string;
  readonly subject: CatalogSubject;
  readonly execution: CookExecution;
  readonly lifecycle: CatalogLifecycle;
  readonly projection: CatalogProjection;
}

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

/** One stable row from a development or build catalog snapshot. */
export interface CatalogEntry {
  readonly guid: string;
  /** GUID-to-pack navigation only; artifact paths live inside Pack v2. */
  readonly packageUrl: string;
  readonly kind: string;
  /** Producer-owned placement/binding facts; absent only on legacy rows. */
  readonly authoring?: AssetAuthoringCapability;
  /** Source declaration navigation for diagnostics, not runtime content. */
  readonly sourcePath: string;
  /** Stable package identity; path is a locator, never the package identity. */
  readonly packageId?: string;
  /** Producer-owned importer/provider identity and version. */
  readonly provenance?: ProviderProvenance;
  /** Producer-owned resource/package revision used for conflict checks. */
  readonly revision?: ResourceRevision;
  /** Stable producer key for imported-output topology matching; never infer it from sourceIndex. */
  readonly sourceKey?: string;
  /** Producer-declared output position; never used as identity when sourceKey exists. */
  readonly sourceIndex?: number;
  /** Producer-owned author facts carried through the catalog without interpretation. */
  readonly sourceOverrides?: SourceOverrideMap;
  readonly sourceOverrideDescriptors?: readonly SourceOverrideDescriptor[];
  /** Typed graph edges emitted by the producer. */
  readonly relations?: readonly AssetRelation[];
  /** Structured producer diagnostics; consumers must not parse messages. */
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly name?: string;
  /** Optional navigation to the producer-owned cook receipt. */
  readonly cookReceiptUrl?: string;
  readonly refs?: readonly string[];
  /** Explicit producer-owned runtime projection axes. */
  readonly subject?: CatalogSubject;
  readonly execution?: CookExecution;
  readonly lifecycle?: CatalogLifecycle;
  readonly projection?: CatalogProjection;
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

export type PackIndexEntry = CatalogEntry;
