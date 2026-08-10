import { err, ok, type Result } from '@forgeax/engine-types';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError, type AppError as AppErrorType } from '../errors';
import { missingExecutionCapabilities } from './capabilities';
import type {
  ExecutionCapabilities,
  ExecutionCapabilityName,
  ExecutionRequestedTier,
  ExecutionSelection,
  ExecutionTier,
} from './types';

const ENGINE_WORKER_CAPABILITIES = [
  'worker',
  'offscreenCanvas',
  'workerWebGpu',
] as const satisfies readonly ExecutionCapabilityName[];
const SHARED_CAPABILITIES = [
  ...ENGINE_WORKER_CAPABILITIES,
  'crossOriginIsolated',
  'sharedArrayBuffer',
  'atomicsWait',
] as const satisfies readonly ExecutionCapabilityName[];

export interface ExecutionSelectionInput {
  readonly requestedTier: ExecutionRequestedTier;
  readonly capabilities: ExecutionCapabilities;
  readonly sharedEvidencePassed: boolean;
}

function requiredCapabilities(tier: ExecutionTier): readonly ExecutionCapabilityName[] {
  if (tier === 'main-serial') return [];
  if (tier === 'engine-worker') return ENGINE_WORKER_CAPABILITIES;
  return SHARED_CAPABILITIES;
}

function missingFor(
  tier: ExecutionTier,
  capabilities: ExecutionCapabilities,
): readonly ExecutionCapabilityName[] {
  return missingExecutionCapabilities(capabilities, requiredCapabilities(tier));
}

export function selectExecutionTier(
  input: ExecutionSelectionInput,
): Result<ExecutionSelection, AppErrorType> {
  if (input.requestedTier !== 'auto') {
    const missing = missingFor(input.requestedTier, input.capabilities);
    if (missing.length > 0 || (input.requestedTier === 'shared' && !input.sharedEvidencePassed)) {
      return err(
        new AppError({
          code: 'app-execution-tier-unavailable',
          expected: APP_EXPECTED['app-execution-tier-unavailable'],
          hint: APP_ERROR_HINTS['app-execution-tier-unavailable'],
          detail: {
            requestedTier: input.requestedTier,
            missingCapabilities: missing,
            sharedEvidencePassed: input.sharedEvidencePassed,
          },
        }),
      );
    }
    return ok({
      requestedTier: input.requestedTier,
      actualTier: input.requestedTier,
      selectionReason: 'explicit-request',
      missingCapabilities: [],
      sharedEvidencePassed: input.sharedEvidencePassed,
    });
  }

  const sharedMissing = missingFor('shared', input.capabilities);
  if (sharedMissing.length === 0 && input.sharedEvidencePassed) {
    return ok({
      requestedTier: 'auto',
      actualTier: 'shared',
      selectionReason: 'auto-shared',
      missingCapabilities: [],
      sharedEvidencePassed: true,
    });
  }
  const workerMissing = missingFor('engine-worker', input.capabilities);
  if (workerMissing.length === 0) {
    return ok({
      requestedTier: 'auto',
      actualTier: 'engine-worker',
      selectionReason: 'auto-engine-worker',
      missingCapabilities: sharedMissing,
      sharedEvidencePassed: input.sharedEvidencePassed,
    });
  }
  return ok({
    requestedTier: 'auto',
    actualTier: 'main-serial',
    selectionReason: 'auto-main-serial',
    missingCapabilities: workerMissing,
    sharedEvidencePassed: input.sharedEvidencePassed,
  });
}
