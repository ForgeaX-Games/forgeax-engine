/** Public RenderFeature lifecycle, diagnostics, and host-context declarations. */
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { RhiCaps } from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import type { RenderError } from '../errors/render';
import type { VisibilitySnapshot } from '../extract/visibility';
import type { RenderFeatureContributionStaging } from './graph-contribution';
import type {
  PreparedKind,
  RenderFeatureGraphicsContributionStaging,
  RenderFeatureGraphicsPrepare,
} from './prepared-graphics';
import type { RenderFeatureTargetHandle } from './targets';

export type { RenderFeatureTargetHandle } from './targets';

/** Closed lifecycle states exposed by the feature host. */
export type RenderFeatureStatus = 'active' | 'failed' | 'disabled' | 'disposed';

/** Callback stages that can attribute a feature failure. */
export type RenderFeatureStage =
  | 'extract'
  | 'prepare'
  | 'contribute'
  | 'record'
  | 'recover'
  | 'dispose';

/** Recovery action attached to a structured feature failure. */
export type RenderFeatureRecovery = 'next-frame' | 'renderer-recover' | 'registration';

/**
 * Render-owned feature error codes. The RenderError union consumes this set;
 * each member has a matching structured detail declaration below.
 */
export type RenderFeatureErrorCode =
  | 'render-feature-registration-conflict'
  | 'render-feature-stage-failed'
  | 'render-feature-capability-missing'
  | 'render-feature-pass-order-conflict'
  | 'render-feature-preparation-failed'
  | 'render-feature-prepared-state-mismatch'
  | 'render-feature-draw-recording-failed';

/** Boolean capability names are derived from the RHI capability source. */
type BooleanCapabilityKey = {
  [Key in keyof RhiCaps]-?: RhiCaps[Key] extends boolean ? Key : never;
}[keyof RhiCaps];

export type RenderFeatureCapabilityKey = BooleanCapabilityKey;

export interface RenderFeatureRegistrationConflictDetail {
  readonly featureIdentity: string;
  readonly order: number;
  readonly conflictingOrder: number;
}

export interface RenderFeatureStageFailedDetail {
  readonly featureIdentity: string;
  readonly order: number;
  readonly stage: RenderFeatureStage;
  readonly recovery: RenderFeatureRecovery;
  readonly cleanupFailures?: readonly RenderFeatureCleanupFailure[];
}

export interface RenderFeatureCleanupFailure {
  readonly featureIdentity: string;
  readonly order: number;
  readonly code: string;
}

export interface RenderFeatureCapabilityMissingDetail {
  readonly featureIdentity: string;
  readonly order: number;
  readonly capability: RenderFeatureCapabilityKey;
}

export interface RenderFeaturePassOrderConflictDetail {
  readonly featureIdentity: string;
  readonly order: number;
  readonly passIdentity: string;
  readonly dependencyIdentity: string;
}

export interface RenderFeaturePreparationFailedDetail {
  readonly featureIdentity: string;
  readonly order: number;
  readonly stage: 'prepare';
  readonly operation: string;
  readonly resourceKind: PreparedKind;
  readonly resourceName: string;
  readonly reason: string;
  readonly recovery: RenderFeatureRecovery;
}

export type RenderFeaturePreparedStateMismatchDetail =
  | {
      readonly featureIdentity: string;
      readonly order: number;
      readonly stage: 'contribute';
      readonly operation: string;
      readonly resourceKind: PreparedKind;
      readonly reason: 'missing-prepared-state';
      readonly missingResource: string;
      readonly recovery: RenderFeatureRecovery;
    }
  | {
      readonly featureIdentity: string;
      readonly order: number;
      readonly stage: 'contribute';
      readonly operation: string;
      readonly resourceKind: PreparedKind;
      readonly reason: 'foreign-feature';
      readonly expectedFeatureIdentity: string;
      readonly actualFeatureIdentity: string;
      readonly recovery: RenderFeatureRecovery;
    }
  | {
      readonly featureIdentity: string;
      readonly order: number;
      readonly stage: 'contribute';
      readonly operation: string;
      readonly resourceKind: PreparedKind;
      readonly reason: 'foreign-kind';
      readonly expectedKind: PreparedKind;
      readonly actualKind: PreparedKind;
      readonly recovery: RenderFeatureRecovery;
    }
  | {
      readonly featureIdentity: string;
      readonly order: number;
      readonly stage: 'contribute';
      readonly operation: string;
      readonly resourceKind: PreparedKind;
      readonly reason: 'generation-mismatch';
      readonly expectedGeneration: number;
      readonly actualGeneration: number;
      readonly recovery: RenderFeatureRecovery;
    }
  | {
      readonly featureIdentity: string;
      readonly order: number;
      readonly stage: 'contribute';
      readonly operation: string;
      readonly resourceKind: PreparedKind;
      readonly reason: 'layout-mismatch';
      readonly expectedLayout: string;
      readonly actualLayout: string;
      readonly recovery: RenderFeatureRecovery;
    }
  | {
      readonly featureIdentity: string;
      readonly order: number;
      readonly stage: 'contribute';
      readonly operation: string;
      readonly resourceKind: PreparedKind;
      readonly reason: 'format-mismatch';
      readonly expectedFormat: string;
      readonly actualFormat: string;
      readonly recovery: RenderFeatureRecovery;
    };

export interface RenderFeatureDrawRecordingFailedDetail {
  readonly featureIdentity: string;
  readonly order: number;
  readonly stage: 'record';
  readonly operation: string;
  readonly resourceKind: PreparedKind;
  readonly reason: string;
  readonly backendReason: string;
  readonly recovery: RenderFeatureRecovery;
}

export type RenderFeatureErrorDetailByCode = {
  'render-feature-registration-conflict': RenderFeatureRegistrationConflictDetail;
  'render-feature-stage-failed': RenderFeatureStageFailedDetail;
  'render-feature-capability-missing': RenderFeatureCapabilityMissingDetail;
  'render-feature-pass-order-conflict': RenderFeaturePassOrderConflictDetail;
  'render-feature-preparation-failed': RenderFeaturePreparationFailedDetail;
  'render-feature-prepared-state-mismatch': RenderFeaturePreparedStateMismatchDetail;
  'render-feature-draw-recording-failed': RenderFeatureDrawRecordingFailedDetail;
};

/** Machine-readable four-field diagnostic exposed by every feature error. */
export type RenderFeatureErrorDescriptor = {
  [Code in RenderFeatureErrorCode]: {
    readonly code: Code;
    readonly expected: string;
    readonly hint: string;
    readonly detail: RenderFeatureErrorDetailByCode[Code];
  };
}[RenderFeatureErrorCode];

export interface RenderFeatureFrameIdentity {
  readonly frameNumber: number;
}

export interface RenderFeatureResourceHandle {
  readonly __renderFeatureResource: unique symbol;
}

export interface RenderFeatureErrorSink {
  report(error: RenderError): void;
}

/** One World-local visibility snapshot prepared for the current frame batch. */
export interface RenderFeatureWorldVisibilitySnapshot {
  readonly world: World;
  readonly snapshot: VisibilitySnapshot;
}

/** A producer's structured report for one hidden render candidate. */
export interface RenderFeatureHiddenEntityReport {
  readonly world: World;
  readonly entity: EntityHandle;
}

export interface RenderFeatureExtractContext {
  readonly worlds: readonly World[];
  readonly owner: number;
  readonly frameNumber: number;
  /** Same-batch World snapshots; absent for synthetic direct feature probes. */
  readonly visibilitySnapshots?: readonly RenderFeatureWorldVisibilitySnapshot[];
  /** Host-owned report sink; feature code never owns the merged diagnostic. */
  readonly reportHiddenEntity?: (report: RenderFeatureHiddenEntityReport) => void;
}

/**
 * Host-owned preparation surface. A feature prepares references here first and
 * consumes them later through the contribute staging surface. The host owns
 * resources and generation validity for the whole lifecycle.
 */
export interface RenderFeaturePrepareContext {
  readonly caps: Readonly<RhiCaps>;
  readonly frame: RenderFeatureFrameIdentity;
  readonly resources: readonly RenderFeatureResourceHandle[];
  readonly targets: readonly RenderFeatureTargetHandle[];
  readonly reportError: RenderFeatureErrorSink;
  /** Controlled pipeline, bindings, vertex-data, and index-data preparation. */
  readonly graphics: RenderFeatureGraphicsPrepare;
}

/** The narrow context visible to a feature-owned graph pass. */
export interface RenderFeaturePassContext {
  readonly frame: RenderFeatureFrameIdentity;
  /** The named pass currently executing inside the active RenderGraph. */
  readonly pass: {
    readonly name: string;
    readonly reads: readonly string[];
    readonly writes: readonly string[];
  };
}

export interface RenderFeatureContributeContext extends RenderFeaturePrepareContext {
  /** Graph-owned staging retains the ordinary graph-only `addPass` path. */
  readonly staging: RenderFeatureContributionStaging & RenderFeatureGraphicsContributionStaging;
}

/**
 * Producer-owned extension seam for one render frame.
 *
 * `FrameData` is the single value that crosses extract, prepare, and
 * contribute. A producer owns its shape; the host owns ordering, failure
 * isolation, graph composition, recovery, generation checks, and disposal.
 * The lifecycle is extract -> prepare -> contribute, with optional recover and
 * dispose callbacks.
 */
export interface RenderFeature<FrameData> {
  readonly identity: string;
  readonly requiredCapabilities?: readonly RenderFeatureCapabilityKey[];
  /**
   * Material shader identifiers whose modules must be ready before the first
   * frame. The renderer resolves these against the loaded manifest and seeds
   * the same lazy module cache used by prepared graphics.
   */
  readonly requiredMaterialShaders?: readonly string[];
  extract(context: RenderFeatureExtractContext): Result<FrameData, RenderError>;
  prepare(data: FrameData, context: RenderFeaturePrepareContext): Result<void, RenderError>;
  contribute(data: FrameData, context: RenderFeatureContributeContext): Result<void, RenderError>;
  recover?(context: RenderFeaturePrepareContext): Result<void, RenderError>;
  dispose?(context: RenderFeaturePrepareContext): Result<void, RenderError>;
}

export interface RenderFeatureRecoverInput {
  readonly caps: Readonly<RhiCaps>;
  readonly frameNumber: number;
}

/** Read-only, machine-readable lifecycle state for one registered feature. */
export interface RenderFeatureDiagnostics {
  readonly identity: string;
  readonly order: number;
  readonly status: RenderFeatureStatus;
  readonly latestError: RenderFeatureErrorDescriptor | undefined;
}
