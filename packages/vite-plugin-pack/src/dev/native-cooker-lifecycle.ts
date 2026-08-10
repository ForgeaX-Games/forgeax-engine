import type { NativeCookDraft, NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import type { AssetStageError, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

export interface NativeCookerLifecycleSnapshot<P = unknown> {
  readonly draft: NativeCookDraft<P>;
  readonly generation: number;
}

export interface NativeCookerLifecycleOptions<P = unknown, I = unknown> {
  readonly registry: NativeCookerRegistry;
  readonly key: string;
  readonly input: I;
  readonly previous?: NativeCookerLifecycleSnapshot<P>;
  readonly validate?: (draft: NativeCookDraft<P>) => string | undefined;
  readonly publish?: (draft: NativeCookDraft<P>, generation: number) => void | Promise<void>;
}

export interface NativeCookerLifecycleResult<P = unknown> extends NativeCookerLifecycleSnapshot<P> {
  readonly status: 'committed' | 'recovered';
  readonly lastKnownGood: NativeCookDraft<P>;
  readonly candidateGeneration: number;
  readonly lastKnownGoodGeneration: number;
  readonly recoveryHint?: string;
}

function lifecycleFailure(key: string, reason: string): AssetStageError {
  return {
    stage: 'native-cook',
    code: 'native-cook-failed',
    expected: 'a valid candidate that can be atomically published',
    hint: reason,
    detail: { guid: 'unknown', producer: key },
    recovery: { action: `repair producer ${key} and rerun the cook`, retryable: true },
  };
}

export async function runNativeCookerLifecycle<P = unknown, I = unknown>(
  options: NativeCookerLifecycleOptions<P, I>,
): Promise<Result<NativeCookerLifecycleResult<P>, AssetStageError>> {
  const candidate = await options.registry.runDraft<P, I>(options.key, options.input);
  if (!candidate.ok) {
    if (options.previous === undefined) return candidate;
    return ok({
      ...options.previous,
      status: 'recovered',
      lastKnownGood: options.previous.draft,
      candidateGeneration: options.previous.generation + 1,
      lastKnownGoodGeneration: options.previous.generation,
      recoveryHint: `repair ${options.key} and submit a new candidate generation`,
    });
  }
  const invalidReason = options.validate?.(candidate.value);
  if (invalidReason !== undefined) {
    if (options.previous === undefined) return err(lifecycleFailure(options.key, invalidReason));
    return ok({
      ...options.previous,
      status: 'recovered',
      lastKnownGood: options.previous.draft,
      candidateGeneration: options.previous.generation + 1,
      lastKnownGoodGeneration: options.previous.generation,
      recoveryHint: `repair ${options.key} and submit a new candidate generation`,
    });
  }
  const generation = (options.previous?.generation ?? 0) + 1;
  try {
    await options.publish?.(candidate.value, generation);
  } catch {
    if (options.previous === undefined) {
      return err(
        lifecycleFailure(
          options.key,
          'atomic producer publication failed; keep the candidate unpublished',
        ),
      );
    }
    return ok({
      ...options.previous,
      status: 'recovered',
      lastKnownGood: options.previous.draft,
      candidateGeneration: options.previous.generation + 1,
      lastKnownGoodGeneration: options.previous.generation,
      recoveryHint: `repair ${options.key} and submit a new candidate generation`,
    });
  }
  return ok({
    draft: candidate.value,
    generation,
    status: 'committed',
    lastKnownGood: candidate.value,
    candidateGeneration: generation,
    lastKnownGoodGeneration: generation,
  });
}
