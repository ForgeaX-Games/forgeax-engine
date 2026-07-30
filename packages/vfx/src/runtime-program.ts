import type { ParticleEffectAsset } from '@forgeax/engine-types';
import type {
  ParticleBackend,
  ParticleBackendPolicy,
  ParticleBounds,
  ParticleCurve,
  ParticleEffectSource,
  ParticleEmitterSchedule,
  ParticleGradient,
  ParticleOperatorStage,
  ParticleOutputSource,
} from './source.js';

/** The single versioned identity shared by cooked and loaded VFX programs. */
export const PARTICLE_PROGRAM_FORMAT = 'forgeax-vfx-program-1' as const;

/** The asset-local artifact that owns the canonical particle program. */
export const PARTICLE_PROGRAM_ARTIFACT_KEY = 'particle-effect/program.json' as const;

/** Runtime backend order and policy derived by the build-time compiler. */
export interface ParticleRuntimeBackendPlan {
  readonly kind: 'cpu' | 'gpu' | 'gpu-with-cpu-fallback' | 'gpu-or-disable';
  readonly backends: readonly ParticleBackend[];
}

/** One ordered, build-time validated stage program consumed by a runtime executor. */
export interface ParticleRuntimeStageProgram {
  readonly operator: `${ParticleOperatorStage}:${string}:${number}` | string;
  readonly program: unknown;
}

/** The complete immutable program projection for one cooked emitter. */
export interface ParticleRuntimeEmitter {
  readonly id: string;
  readonly capacity: number;
  readonly space: 'local' | 'world';
  readonly schedule: ParticleEmitterSchedule;
  readonly bounds: ParticleBounds;
  readonly backendPolicy: ParticleBackendPolicy;
  readonly backendPlan: ParticleRuntimeBackendPlan;
  readonly operators: ParticleEffectSource['emitters'][number]['operators'];
  readonly curves?: Readonly<Record<string, ParticleCurve>>;
  readonly gradients?: Readonly<Record<string, ParticleGradient>>;
  readonly output: ParticleOutputSource;
  readonly programs: Readonly<
    Partial<Record<ParticleBackend, readonly ParticleRuntimeStageProgram[]>>
  >;
}

/**
 * Read-only runtime view of the asset-local canonical particle program.
 *
 * The projection is derived at load time and is never written into the
 * persistent Pack payload or rebuilt from source at runtime.
 */
export interface ParticleRuntimeProgram {
  readonly format: typeof PARTICLE_PROGRAM_FORMAT;
  readonly emitters: readonly ParticleRuntimeEmitter[];
}

/** A loaded asset payload paired with its validated runtime program view. */
export type LoadedParticleEffect = ParticleEffectAsset & {
  readonly program: ParticleRuntimeProgram;
};

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
