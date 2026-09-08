export type ToolRealm = 'build' | 'host' | 'engine';

export type ToolEvidenceKind = 'rhi-tape' | 'profile-capture' | 'png';

/** Stable subject identity carried by a domain contribution, never a live handle. */
export interface ToolSubjectRef {
  readonly kind: string;
  readonly guid: string;
}

/** The portable preview contract shared by descriptor, terminal and artifact readers. */
export interface ToolPreviewContract {
  readonly realm: ToolRealm;
  readonly subject: ToolSubjectRef;
  readonly snapshot: SnapshotRef;
  readonly requiredEvidence: readonly ToolEvidenceKind[];
}

/** Resource census captured after a lexical ToolRun lease has terminated. */
export interface ToolCleanupCensus {
  readonly worlds: number;
  readonly renderers: number;
  readonly canvases: number;
  readonly leases: number;
}

export interface ToolCleanupReport {
  readonly census: ToolCleanupCensus;
  readonly failures: readonly string[];
}

export type ToolTimingPhase =
  | 'lookup'
  | 'lease'
  | 'transport'
  | 'execute'
  | 'capture'
  | 'finalize'
  | 'analyze';

export type ToolPhaseObservation =
  | { readonly status: 'observed'; readonly durationMs: number; readonly workUnits?: number }
  | { readonly status: 'not-applicable' }
  | { readonly status: 'unavailable'; readonly reason: string };

export type ToolResourceObservation =
  | { readonly status: 'observed'; readonly bytes: number; readonly source: string }
  | { readonly status: 'not-applicable' }
  | { readonly status: 'unavailable'; readonly reason: string };

export type ToolResourceKind = 'node-rss' | 'browser-js-heap' | 'artifact-bytes' | 'gpu-memory';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ToolCapability<T> {
  readonly id: string;
  readonly __toolCapability?: T;
}

export type ToolCapabilityResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ToolRuntimeError };

export type ToolCapabilityResolver = <T>(
  capability: ToolCapability<T>,
) => ToolCapabilityResult<T> | undefined;

export interface ToolSchema<T> {
  readonly parse: (value: unknown) => ToolSchemaResult<T>;
  readonly describe?: string;
}

export type ToolSchemaResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export interface ToolDescriptor<TArgs = unknown, TResult = unknown> {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly realm: ToolRealm;
  readonly argsSchema: ToolSchema<TArgs>;
  readonly resultSchema: ToolSchema<TResult>;
  readonly evidence: readonly ToolEvidenceKind[];
  /** Domain preview descriptors bind a subject and snapshot without exposing live state. */
  readonly preview?: ToolPreviewContract;
}

export interface ToolSnapshotInput {
  readonly snapshot?: SnapshotRef;
  readonly projectRoot?: string;
}

export interface ToolExecutionContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly snapshot?: SnapshotRef;
  readonly emit: (event: ToolRunEvent) => void;
  readonly addCleanup: (cleanup: () => void | Promise<void>) => void;
  readonly setCleanupReport: (report: ToolCleanupReport) => void;
  readonly require: <T>(capability: ToolCapability<T>) => ToolCapabilityResult<T>;
  readonly runChild: <TChildArgs, TChildResult>(
    contribution: ToolContribution<TChildArgs, TChildResult>,
    args: TChildArgs,
    options?: ToolRunOptions,
  ) => Promise<ToolTerminal<TChildResult>>;
}

export interface ToolRecoveryAction {
  readonly action: 'retry' | 'switch-operation' | 'repair-owner' | 'inspect-evidence' | 'stop';
  readonly hint: string;
  readonly operation?: string;
}

export type ToolDomainFailure = {
  readonly code: string;
  readonly expected?: string;
  readonly hint?: string;
  readonly detail?: JsonValue;
};

export type ToolExecutor<TArgs, TResult> = (
  args: TArgs,
  context: ToolExecutionContext,
) => ToolExecutorResult<TResult>;

export type ToolExecutorValue<TResult> =
  | TResult
  | ToolTerminal<TResult>
  | {
      readonly ok: true;
      readonly value: TResult;
      readonly snapshotAfter?: SnapshotRef;
      readonly artifacts?: readonly ArtifactRef[];
      readonly cleanup?: ToolCleanupReport;
    }
  | { readonly ok: false; readonly error: ToolDomainFailure };

export type ToolExecutorResult<TResult> =
  | ToolExecutorValue<TResult>
  | Promise<ToolExecutorValue<TResult>>;

export interface ToolContribution<TArgs = unknown, TResult = unknown> {
  readonly descriptor: ToolDescriptor<TArgs, TResult>;
  readonly execute: ToolExecutor<TArgs, TResult>;
}

export interface ToolRunOptions extends ToolSnapshotInput {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly evidence?: readonly ToolEvidenceKind[];
  readonly capabilityResolver?: ToolCapabilityResolver;
}

export type ToolRunEvent =
  | { readonly kind: 'started'; readonly runId: string; readonly atMs: number }
  | {
      readonly kind: 'progress';
      readonly runId: string;
      readonly message: string;
      readonly atMs: number;
    }
  | {
      readonly kind: 'child-started';
      readonly runId: string;
      readonly childRunId: string;
      readonly atMs: number;
    }
  | {
      readonly kind: 'terminal';
      readonly runId: string;
      readonly outcome: ToolTerminal<unknown>['outcome'];
      readonly atMs: number;
    };

export interface ToolRun<TResult> {
  readonly id: string;
  readonly events: AsyncIterable<ToolRunEvent>;
  readonly terminal: Promise<ToolTerminal<TResult>>;
  readonly cancel: (reason?: string) => void;
  readonly disconnect: (transport?: string) => void;
  readonly providerExit: (provider?: string) => void;
}

export interface ToolTiming {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly phases?: Readonly<Record<ToolTimingPhase, ToolPhaseObservation>>;
  readonly unattributedMs?: number;
  readonly resources?: Readonly<Partial<Record<ToolResourceKind, ToolResourceObservation>>>;
}

export type ToolTerminal<TResult> =
  | {
      readonly outcome: 'succeeded';
      readonly result: TResult;
      readonly snapshotAfter?: SnapshotRef;
      readonly artifacts: readonly ArtifactRef[];
      readonly cleanup?: ToolCleanupReport;
      readonly timing?: ToolTiming;
    }
  | {
      readonly outcome: 'failed';
      readonly failure: ToolRuntimeError;
      readonly snapshotAfter?: SnapshotRef;
      readonly artifacts: readonly ArtifactRef[];
      readonly cleanup?: ToolCleanupReport;
      readonly timing?: ToolTiming;
    };

export interface SnapshotRef {
  readonly revision: number;
  readonly digest: string;
}

export interface ArtifactRef {
  readonly kind: ToolEvidenceKind | 'tool-result' | 'receipt';
  readonly digest: string;
  readonly uri?: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
}

export type ToolRuntimeError =
  | {
      readonly code: 'tool-bootstrap-not-clone-safe';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string };
    }
  | {
      readonly code: 'tool-migration-live-state';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly path: string; readonly key: string };
    }
  | {
      readonly code: 'tool-invalid-args';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string; readonly value: JsonValue };
    }
  | {
      readonly code: 'tool-capability-unavailable';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly capability: string; readonly realm: ToolRealm };
    }
  | {
      readonly code: 'tool-snapshot-stale';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly expectedDigest: string; readonly actualDigest: string };
    }
  | {
      readonly code: 'tool-artifact-incomplete';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly missing: readonly ToolEvidenceKind[]; readonly runId: string };
    }
  | {
      readonly code: 'tool-run-cancelled';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly reason: string };
    }
  | {
      readonly code: 'tool-run-timeout';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly deadlineMs: number };
    }
  | {
      readonly code: 'tool-run-disconnected';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly transport: string };
    }
  | {
      readonly code: 'tool-run-terminal';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly runId: string;
        readonly outcome: ToolTerminal<unknown>['outcome'];
      };
    }
  | {
      readonly code: 'tool-catalog-stale';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly id: string;
        readonly expectedDigest: string;
        readonly actualDigest?: string;
      };
    }
  | {
      readonly code: 'tool-cleanup-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly runId: string; readonly message: string };
    }
  | {
      readonly code: 'tool-domain-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly code: string;
        readonly payload?: JsonValue;
        readonly suggestedOperation?: string;
        readonly recovery?: readonly ToolRecoveryAction[];
      };
    }
  | {
      readonly code: 'tool-artifact-manifest-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly reason: string; readonly runId?: string };
    }
  | {
      readonly code: 'tool-timing-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly reason: string };
    };

export type ToolRuntimeErrorCode = ToolRuntimeError['code'];
