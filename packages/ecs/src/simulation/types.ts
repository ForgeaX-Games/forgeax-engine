import type { Result } from '@forgeax/engine-types';

export const SIMULATION_RECORD_FORMAT_VERSION = 1 as const;
export type SimulationRecordFormatVersion = typeof SIMULATION_RECORD_FORMAT_VERSION;

export interface SimulationClockProjection {
  readonly time: {
    readonly delta: number;
    readonly elapsed: number;
  };
  readonly fixed: {
    readonly delta: number;
    readonly tick: number;
    readonly overstep: number;
    readonly droppedSeconds: number;
    readonly droppedUpdates: number;
  };
}

export interface SimulationComponentProjection {
  readonly component: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface SimulationEntityProjection {
  readonly localId: number;
  readonly components: readonly SimulationComponentProjection[];
}

export interface SimulationResourceProjection {
  readonly key: string;
  readonly schemaFingerprint: string;
  readonly value: unknown;
}

export interface SimulationWorldProjection {
  readonly entities: readonly SimulationEntityProjection[];
  readonly resources: readonly SimulationResourceProjection[];
}

export interface SimulationParticipantRecord {
  readonly id: string;
  readonly version: string;
  readonly schemaFingerprint: string;
  readonly state: unknown;
}

/** One fixed-tick input sample; presentation and DOM state stay outside the record. */
export interface SimulationTraceSample {
  readonly tick: number;
  readonly input: unknown;
}

export const SIMULATION_COMPARISON_DOMAINS = [
  'world',
  'collision',
  'audio',
  'cleanup',
  'final-invariant',
] as const;

export type SimulationComparisonDomain = (typeof SIMULATION_COMPARISON_DOMAINS)[number];

export interface SimulationComparisonFact {
  readonly domain: SimulationComparisonDomain;
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly tolerance?: number | undefined;
}

export interface SimulationComparisonEntry extends SimulationComparisonFact {
  readonly verdict: 'match' | 'mismatch';
  readonly difference?: number;
}

export interface SimulationComparisonInput {
  readonly facts: readonly SimulationComparisonFact[];
}

export interface SimulationComparisonDomainSummary {
  readonly compared: number;
  readonly mismatches: number;
}

export interface SimulationComparisonReport {
  readonly verdict: 'match' | 'mismatch';
  readonly entries: readonly SimulationComparisonEntry[];
  readonly mismatches: readonly SimulationComparisonEntry[];
  readonly cleanup: SimulationComparisonDomainSummary;
  readonly finalInvariants: SimulationComparisonDomainSummary;
}

/** Semantic evidence uses the same comparison report; it has no render/pixel layer. */
export type SimulationEvidenceReport = SimulationComparisonReport;

export interface SimulationRecordInput {
  readonly recordTick: number;
  readonly clock: SimulationClockProjection;
  readonly world: SimulationWorldProjection;
  readonly participants: readonly SimulationParticipantRecord[];
  readonly trace: readonly SimulationTraceSample[];
}

/** Versioned portable state owned by ECS; this is not a disk, network, or game-replay format. */
export interface SimulationRecordV1 extends SimulationRecordInput {
  readonly formatVersion: SimulationRecordFormatVersion;
  readonly fingerprint: string;
}

export interface SimulationRecordInvalidDetail {
  readonly path: string;
  readonly expected: string;
  readonly received?: unknown;
}

export const SIMULATION_ERROR_CODES = [
  'simulation-record-invalid',
  'simulation-state-unsupported',
  'simulation-resource-invalid',
  'simulation-entity-unmapped',
  'simulation-participant-duplicate',
  'simulation-participant-missing',
  'simulation-participant-version-mismatch',
  'simulation-participant-schema-mismatch',
  'simulation-participant-not-ready',
  'simulation-participant-prepare-failed',
  'simulation-trace-invalid',
  'simulation-compare-invalid',
  'simulation-target-not-fresh',
] as const;

export interface SimulationErrorDetailMap {
  readonly 'simulation-record-invalid': SimulationRecordInvalidDetail;
  readonly 'simulation-state-unsupported': {
    readonly path: string;
    readonly component?: string;
    readonly field?: string;
  };
  readonly 'simulation-resource-invalid': { readonly key: string; readonly path: string };
  readonly 'simulation-entity-unmapped': {
    readonly sourceId: number;
    readonly path: string;
  };
  readonly 'simulation-participant-duplicate': { readonly id: string };
  readonly 'simulation-participant-missing': {
    readonly id: string;
    readonly expectedVersion: string;
    readonly expectedSchemaFingerprint: string;
  };
  readonly 'simulation-participant-version-mismatch': {
    readonly id: string;
    readonly expectedVersion: string;
    readonly actualVersion: string;
  };
  readonly 'simulation-participant-schema-mismatch': {
    readonly id: string;
    readonly expectedSchemaFingerprint: string;
    readonly actualSchemaFingerprint: string;
  };
  readonly 'simulation-participant-not-ready': { readonly id: string };
  readonly 'simulation-participant-prepare-failed': {
    readonly id: string;
    readonly path: string;
  };
  readonly 'simulation-trace-invalid': {
    readonly path: string;
    readonly expected: string;
    readonly received?: unknown;
  };
  readonly 'simulation-compare-invalid': {
    readonly path: string;
    readonly expected: string;
    readonly received?: unknown;
  };
  readonly 'simulation-target-not-fresh': { readonly entityCount: number };
}

export type SimulationErrorCode = (typeof SIMULATION_ERROR_CODES)[number];

export type SimulationErrorFor<C extends SimulationErrorCode> = Error & {
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SimulationErrorDetailMap[C];
};

export type SimulationError = {
  [C in SimulationErrorCode]: SimulationErrorFor<C>;
}[SimulationErrorCode];

export interface SimulationParticipantStage {
  readonly state: unknown;
}

export interface SimulationRecordContext {
  readonly mapEntity: (sourceEntity: number) => number | undefined;
}

export interface SimulationRestoreContext {
  readonly entityCount: number;
  readonly entityMap?: ReadonlyMap<number, number>;
}

export interface SimulationParticipant {
  readonly id: string;
  readonly version: string;
  readonly schemaFingerprint: string;
  readonly isReady: () => boolean;
  readonly recordState?: (context?: SimulationRecordContext) => Result<unknown, SimulationError>;
  readonly prepareRestore: (
    state: unknown,
    context?: SimulationRestoreContext,
  ) => Result<SimulationParticipantStage, SimulationError>;
  readonly commitRestore: (
    stage: SimulationParticipantStage,
    context?: SimulationRestoreContext,
  ) => void;
  readonly disposeRestore: (stage: SimulationParticipantStage) => void;
}
