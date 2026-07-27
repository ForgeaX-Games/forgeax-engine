// @forgeax/engine-types - producer-owned asset catalog contract.
//
// This is the shared POD boundary between an engine asset producer and any
// consumer. Consumers must use these facts instead of deriving origin from a
// DDC URL, filename suffix, or catalog position.

export type AssetSubjectType = 'asset' | 'package' | 'resource';

/** Stable producer subject identity used by relations and diagnostics. */
export interface AssetSubjectRef {
  readonly type: AssetSubjectType;
  readonly id: string;
}

/** Provider identity carried with producer-owned facts; not a catalog locator. */
export interface ProviderProvenance {
  readonly provider: string;
  readonly version: string;
  readonly source?: string;
}

/** Monotonic producer observation used to validate catalog continuity. */
export interface ResourceRevision {
  readonly digest: string;
  readonly observedAt: number;
  readonly rootId: string;
}

export type AssetRelationType =
  | 'references'
  | 'reads'
  | 'depends-on'
  | 'owns'
  | 'contains'
  | 'produces'
  | 'materialized-as'
  | (string & {});

export interface AssetRelationPolicy {
  readonly ownership?: 'owned' | 'shared';
  readonly lifecycle?: 'authored' | 'derived';
  readonly strength?: 'required' | 'optional';
}

/** Structured graph edge emitted by a producer; consumers must preserve its fields. */
export interface AssetRelation {
  readonly from: AssetSubjectRef;
  readonly to: AssetSubjectRef;
  readonly type: AssetRelationType;
  readonly policy?: AssetRelationPolicy;
  readonly provenance: ProviderProvenance;
}

export type CatalogDiagnosticSeverity = 'info' | 'warning' | 'blocking';

/** Machine-readable catalog problem; consumers branch on fields, never message text. */
export interface CatalogDiagnostic {
  readonly code: string;
  readonly severity: CatalogDiagnosticSeverity;
  readonly message?: string;
  readonly subject?: AssetSubjectRef;
  readonly expected?: string;
  readonly actual?: string;
  readonly hint?: string;
  readonly authority?: 'producer' | 'pack' | 'catalog';
  readonly evidence?: readonly AssetSubjectRef[];
  readonly recoveryIntents?: readonly string[];
}

/** Closed set of contract failures returned by producer validation. */
export type ProducerContractErrorCode =
  | 'missing-source-key'
  | 'duplicate-source-key'
  | 'source-index-ambiguous'
  | 'invalid-source-key'
  | 'invalid-source-index'
  | 'invalid-producer-fact';

/** Structured producer validation failure with its owning authority. */
export interface ProducerContractDiagnostic {
  readonly code: ProducerContractErrorCode;
  readonly subject: AssetSubjectRef;
  readonly expected: string;
  readonly actual?: string;
  readonly hint: string;
  readonly authority: 'producer' | 'pack';
}

/** Result boundary for producer validation; success and failure are discriminated by `ok`. */
export type ProducerContractResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProducerContractDiagnostic };

/** Canonical producer output declaration used for topology matching and recovery. */
export interface ImportedOutputDeclaration {
  readonly guid: string;
  readonly sourceKey?: string;
  readonly sourceIndex: number;
  readonly kind: string;
  readonly name?: string;
  /** New kinds that may reuse this output's prior GUID. */
  readonly compatiblePreviousKinds?: readonly string[];
}

export type ProposedOutput = ImportedOutputDeclaration;

export type ExistingOutput = ImportedOutputDeclaration;

export interface KindChange {
  readonly guid: string;
  readonly oldKind: string;
  readonly newKind: string;
  readonly sourceKey?: string;
  readonly action: 'remove-add' | 'preserve-guid';
}

export type TopologyConflictReason =
  | 'duplicate-source-key'
  | 'missing-source-key'
  | 'source-index-ambiguous';

export interface MatchConflict {
  readonly reason: TopologyConflictReason;
  readonly sourceKey?: string;
  readonly previous: readonly ExistingOutput[];
  readonly next: readonly ProposedOutput[];
}

export interface TopologyPreserved {
  readonly guid: string;
  readonly oldKey: string;
  readonly newKey: string;
}

export interface TopologyDiff {
  readonly preserved: readonly TopologyPreserved[];
  readonly added: readonly ProposedOutput[];
  readonly removed: readonly ExistingOutput[];
  readonly changedKind: readonly KindChange[];
  readonly ambiguous: readonly MatchConflict[];
}
