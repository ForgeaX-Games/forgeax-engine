// @forgeax/engine-types - producer-owned asset catalog contract.
//
// This is the shared POD boundary between an engine asset producer and any
// consumer. Consumers must use these facts instead of deriving origin from a
// DDC URL, filename suffix, or catalog position.

export type AssetSubjectType = 'asset' | 'package' | 'resource';

/** The producer-owned subject behind a catalog row. */
export type CatalogSubject = 'internal-asset' | 'imported-output';

/** Whether the runtime projection is validated directly or cooked. */
export type CookExecution = 'direct' | 'cooked';

/** Derived lifecycle states exposed by the catalog. */
export type CatalogLifecycle = 'missing' | 'cooking' | 'current' | 'stale' | 'failed';

export type CatalogOperationName =
  | 'preview'
  | 'save'
  | 'rebuild'
  | 'sourceOverride'
  | 'instanceOverride'
  | 'promote';

export interface CatalogOperationDescriptor {
  readonly operation: CatalogOperationName;
  readonly enabled: boolean;
  readonly reason?: string;
}

export type CatalogOperations = Readonly<Record<CatalogOperationName, CatalogOperationDescriptor>>;

export interface CatalogProjectionInput {
  readonly subject: CatalogSubject;
  readonly execution: CookExecution;
  readonly lifecycle: CatalogLifecycle;
}

/** The explicit three-axis projection consumed by AI-facing catalog clients. */
export interface CatalogProjection extends CatalogProjectionInput {
  readonly operations: CatalogOperations;
  readonly lastKnownGood?: {
    readonly packageUrl: string;
    readonly receiptUrl?: string;
  };
}

/**
 * Derive operation descriptors from catalog facts only.
 *
 * `kind`, paths, and diagnostic messages are intentionally absent from this
 * function: a consumer receives a complete operation matrix and can branch
 * on `enabled` without reimplementing producer policy.
 */
export function catalogOperationsFor(input: CatalogProjectionInput): CatalogOperations {
  const imported = input.subject === 'imported-output';
  const current = input.lifecycle === 'current';
  const ready = current && (input.execution === 'direct' || input.execution === 'cooked');
  const canRebuild = input.execution === 'cooked';
  const canPreview = input.execution === 'cooked' && input.lifecycle !== 'missing';
  const operation = (name: CatalogOperationName, enabled: boolean, reason?: string) => ({
    operation: name,
    enabled,
    ...(reason === undefined ? {} : { reason }),
  });

  return {
    preview: operation('preview', canPreview, canPreview ? undefined : 'no projection to preview'),
    save: operation(
      'save',
      !imported && input.execution === 'direct' && ready,
      imported ? 'imported output is read-only' : 'direct projection is not current',
    ),
    rebuild: operation(
      'rebuild',
      canRebuild,
      canRebuild ? undefined : 'direct assets do not require a cook',
    ),
    sourceOverride: operation(
      'sourceOverride',
      imported && canRebuild,
      imported
        ? canRebuild
          ? undefined
          : 'cooked projection is not available'
        : 'only imported output has a source override',
    ),
    instanceOverride: operation(
      'instanceOverride',
      imported && current,
      imported
        ? current
          ? undefined
          : 'projection is not current'
        : 'only imported output has an instance override',
    ),
    promote: operation(
      'promote',
      imported && current,
      imported
        ? current
          ? undefined
          : 'projection is not current'
        : 'internal assets are already authored',
    ),
  };
}

/** Reject impossible axis combinations before a catalog row is published. */
export function isCatalogProjectionValid(input: CatalogProjection): boolean {
  if (input.execution === 'direct' && input.lifecycle !== 'current') return false;
  if (input.subject === 'imported-output' && input.execution !== 'cooked') return false;
  return Object.entries(input.operations).every(
    ([name, descriptor]) => name === descriptor.operation,
  );
}

/** Structured reason for an authoring capability that is not available. */
export type AssetAuthoringUnavailableCode =
  | 'unsupported-asset-kind'
  | 'missing-producer-capability';

export interface AssetAuthoringUnavailableReason {
  readonly code: AssetAuthoringUnavailableCode;
  readonly hint: string;
}

/** Engine-facing operation shape exposed by a producer-owned catalog row. */
export type AssetPlacementCapability =
  | { readonly operation: 'spawnEntity' }
  | { readonly operation: 'addSceneAssetToScene' }
  | { readonly operation: 'unavailable'; readonly reason: AssetAuthoringUnavailableReason };

export interface AssetBindingTarget {
  readonly component: string;
  readonly field: string;
  readonly assetType: string;
  readonly cardinality: 'single' | 'array';
}

export type AssetBindingCapability =
  | {
      readonly operation: 'bindAssetRef' | 'createMaterialThenBindAssetRef';
      readonly target: AssetBindingTarget;
      readonly requiredSlots: 1;
    }
  | { readonly operation: 'unavailable'; readonly reason: AssetAuthoringUnavailableReason };

/** Producer-owned placement and binding facts for one catalog asset. */
export interface AssetAuthoringCapability {
  readonly placement: AssetPlacementCapability;
  readonly binding: AssetBindingCapability;
}

/** Built-in defaults for legacy rows that do not carry an explicit override. */
export function authoringCapabilityForAssetKind(kind: string): AssetAuthoringCapability {
  switch (kind) {
    case 'scene':
      return {
        placement: { operation: 'addSceneAssetToScene' },
        binding: {
          operation: 'unavailable',
          reason: {
            code: 'unsupported-asset-kind',
            hint: 'Scene assets are placed as a scene mount.',
          },
        },
      };
    case 'mesh':
      return {
        placement: { operation: 'spawnEntity' },
        binding: {
          operation: 'bindAssetRef',
          target: {
            component: 'MeshFilter',
            field: 'assetHandle',
            assetType: 'MeshAsset',
            cardinality: 'single',
          },
          requiredSlots: 1,
        },
      };
    case 'material':
      return {
        placement: { operation: 'spawnEntity' },
        binding: {
          operation: 'bindAssetRef',
          target: {
            component: 'MeshRenderer',
            field: 'materials',
            assetType: 'MaterialAsset',
            cardinality: 'array',
          },
          requiredSlots: 1,
        },
      };
    case 'texture':
      return {
        placement: { operation: 'spawnEntity' },
        binding: {
          operation: 'createMaterialThenBindAssetRef',
          target: {
            component: 'MeshRenderer',
            field: 'materials',
            assetType: 'MaterialAsset',
            cardinality: 'array',
          },
          requiredSlots: 1,
        },
      };
    default:
      return {
        placement: {
          operation: 'unavailable',
          reason: {
            code: 'unsupported-asset-kind',
            hint: `No placement capability is published for asset kind '${kind}'.`,
          },
        },
        binding: {
          operation: 'unavailable',
          reason: {
            code: 'unsupported-asset-kind',
            hint: `No binding capability is published for asset kind '${kind}'.`,
          },
        },
      };
  }
}

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
