import type { Result } from '@forgeax/engine-ecs';

export type ParticleRuntimeHostAttachState = 'attached' | 'already-attached';
export type ParticleRuntimeHostDetachState = 'detached' | 'not-attached';

export interface ParticleRuntimeHostAttachResult {
  readonly state: ParticleRuntimeHostAttachState;
}

export interface ParticleRuntimeHostDetachResult {
  readonly state: ParticleRuntimeHostDetachState;
}

export type ParticleRuntimeHostErrorCode =
  | 'particle-runtime-loader-install-failed'
  | 'particle-runtime-plugin-build-failed'
  | 'particle-runtime-world-detach-failed';

export interface ParticleRuntimeHostError {
  readonly code: ParticleRuntimeHostErrorCode;
  readonly expected: string;
  readonly actual: unknown;
  readonly hint: string;
  readonly retryable: boolean;
}

export type ParticleRuntimeHostResult<T> = Result<T, ParticleRuntimeHostError>;

export function particleRuntimeHostError(
  code: ParticleRuntimeHostErrorCode,
  actual: unknown,
): ParticleRuntimeHostError {
  const hint =
    code === 'particle-runtime-loader-install-failed'
      ? 'repair the shared AssetRegistry loader table and retry host attach'
      : code === 'particle-runtime-plugin-build-failed'
        ? 'repair the World plugin binding and retry host attach'
        : 'keep the World binding alive until its FixedUpdate system can be detached';
  return Object.freeze({
    code,
    expected: 'the ParticleRuntimeHost world binding to remain consistent',
    actual,
    hint,
    retryable: true,
  });
}
