import type { AudioState } from '@forgeax/engine-audio';
import { EXECUTION_REPORT_SCHEMA_VERSION } from './schema';
import type {
  ExecutionCapabilities,
  ExecutionReport,
  ExecutionRequestedTier,
  ExecutionSelection,
} from './types';

export function executionAudioReport(state?: AudioState): ExecutionReport['audio'] {
  const error = state?.lastError ?? null;
  return {
    owner: 'host',
    contextState: state?.contextState ?? 'suspended',
    activeSourceCount: state?.activeSourceCount ?? 0,
    lastError:
      error === null
        ? null
        : {
            code: error.code,
            expected: error.expected,
            hint: error.hint,
            detail: error.detail,
          },
  };
}

export function createExecutionReport(
  requestedTier: ExecutionRequestedTier,
  capabilities: ExecutionCapabilities,
  selection?: ExecutionSelection,
): ExecutionReport {
  return {
    schemaVersion: EXECUTION_REPORT_SCHEMA_VERSION,
    requestedTier,
    actualTier: selection?.actualTier ?? null,
    selectionReason: selection?.selectionReason ?? null,
    sharedEvidencePassed: selection?.sharedEvidencePassed ?? false,
    capabilities,
    engine: {
      realm: selection?.actualTier === 'main-serial' ? 'host' : 'worker',
      health: 'idle',
    },
    world: {
      identity: null,
      health: 'healthy',
      partialWrite: false,
      retryable: true,
    },
    kernelDispatch: {
      eligible: false,
      usedShared: false,
      reason: 'no-eligible-kernel',
      dispatched: 0,
      completed: 0,
    },
    performance: {
      hostFrameMs: null,
      engineUpdateMs: null,
      kernelWaitMs: null,
      hostAudioMs: null,
    },
    audio: executionAudioReport(),
    fault: null,
  };
}
