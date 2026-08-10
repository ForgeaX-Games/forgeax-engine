import type { Result } from '@forgeax/engine-types';
import type { AppError } from '../errors';

export const EXECUTION_TIERS = ['main-serial', 'engine-worker', 'shared'] as const;
export type ExecutionTier = (typeof EXECUTION_TIERS)[number];

export const EXECUTION_REQUESTED_TIERS = ['auto', ...EXECUTION_TIERS] as const;
export type ExecutionRequestedTier = (typeof EXECUTION_REQUESTED_TIERS)[number];

export const EXECUTION_CAPABILITY_NAMES = [
  'worker',
  'offscreenCanvas',
  'workerAnimationFrame',
  'workerWebGpu',
  'crossOriginIsolated',
  'sharedArrayBuffer',
  'atomicsWait',
] as const;
export type ExecutionCapabilityName = (typeof EXECUTION_CAPABILITY_NAMES)[number];

export interface ExecutionCapabilityFact {
  readonly available: boolean;
  readonly reason: string;
}

export type ExecutionCapabilities = Readonly<
  Record<ExecutionCapabilityName, ExecutionCapabilityFact>
>;

export type ExecutionSelectionReason =
  | 'explicit-request'
  | 'auto-shared'
  | 'auto-engine-worker'
  | 'auto-main-serial';

export interface ExecutionSelection {
  readonly requestedTier: ExecutionRequestedTier;
  readonly actualTier: ExecutionTier;
  readonly selectionReason: ExecutionSelectionReason;
  readonly missingCapabilities: readonly ExecutionCapabilityName[];
  readonly sharedEvidencePassed: boolean;
}

export type ExecutionEngineHealth = 'idle' | 'starting' | 'running' | 'stopped' | 'faulted';
export type ExecutionWorldHealth = 'healthy' | 'poisoned';

export type KernelDispatchReason =
  | 'no-eligible-kernel'
  | 'zero-work'
  | 'small-span'
  | 'forced-inline'
  | 'shared'
  | 'poisoned';

export interface ExecutionMeasurement {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly jitter: number;
}

export interface ExecutionFault {
  readonly source: 'bootstrap' | 'handshake' | 'runtime' | 'kernel' | 'world' | 'rebuild';
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: unknown;
  readonly partialWrite: boolean;
  readonly retryable: boolean;
}

export interface ExecutionAudioReport {
  readonly owner: 'host';
  readonly contextState: 'running' | 'suspended' | 'closed';
  readonly activeSourceCount: number;
  readonly lastError: {
    readonly code: string;
    readonly expected: string;
    readonly hint: string;
    readonly detail: unknown;
  } | null;
}

export interface ExecutionReport {
  readonly schemaVersion: 1;
  readonly requestedTier: ExecutionRequestedTier;
  readonly actualTier: ExecutionTier | null;
  readonly selectionReason: ExecutionSelectionReason | null;
  readonly sharedEvidencePassed: boolean;
  readonly capabilities: ExecutionCapabilities;
  readonly engine: {
    readonly realm: 'host' | 'worker';
    readonly health: ExecutionEngineHealth;
  };
  readonly world: {
    readonly identity: string | null;
    readonly health: ExecutionWorldHealth;
    readonly partialWrite: boolean;
    readonly retryable: boolean;
  };
  readonly kernelDispatch: {
    readonly eligible: boolean;
    readonly usedShared: boolean;
    readonly reason: KernelDispatchReason;
    readonly dispatched: number;
    readonly completed: number;
  };
  readonly performance: {
    readonly hostFrameMs: ExecutionMeasurement | null;
    readonly engineUpdateMs: ExecutionMeasurement | null;
    readonly kernelWaitMs: ExecutionMeasurement | null;
    readonly hostAudioMs: ExecutionMeasurement | null;
  };
  readonly audio: ExecutionAudioReport;
  readonly fault: ExecutionFault | null;
}

export interface ExecutionOptions {
  readonly tier?: ExecutionRequestedTier;
  /** Absolute or import.meta.url-relative URL of a module whose default export is BootstrapEntry. */
  readonly bootstrap: string | URL;
  readonly startupTimeoutMs?: number;
  readonly frameTimeoutMs?: number;
}

export interface ExecutionControl {
  report(): ExecutionReport;
  rebuild(): Promise<Result<ExecutionReport, AppError>>;
}
