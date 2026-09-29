// @forgeax/engine-types - runtime-safe VFX asset vocabulary.

/** Runtime-ready definition for one cooked particle emitter. */
export interface ParticleEmitterDefinition {
  readonly id: string;
  readonly capacity: number;
}

/** Serializable cooked GPU program carried by the ordinary particle asset. */
export interface ParticleEffectProgram {
  readonly format: 'forgeax-vfx-program-4';
  readonly fingerprint: string;
  readonly emitters: readonly ParticleEffectProgramEmitter[];
}

export interface ParticleEffectProgramEmitter {
  readonly id: string;
  readonly module: string;
  readonly capacity: number;
  readonly backend: { readonly required: 'gpu' };
  readonly space: 'local' | 'world';
  readonly schedule: object;
  readonly bounds: object;
  readonly renderers: readonly object[];
  readonly simulationWhenCulled: 'continue' | 'pause' | 'restart-on-visible';
  readonly wgsl: string;
  readonly reflection: object;
  readonly channels?: readonly object[];
  readonly events?: readonly object[];
}

/** Cooked particle effect payload shared by asset and ECS consumers. */
export interface ParticleEffectAsset {
  readonly kind: 'particle-effect';
  readonly schemaVersion: 3;
  /** Stable producer fingerprint used to detect stale cooked programs. */
  readonly programFingerprint: string;
  readonly emitters: readonly ParticleEmitterDefinition[];
  readonly program: ParticleEffectProgram;
}

/** Narrow Program v3 payload used by the new code-first compiler boundary. */
export interface ParticleEffectProgramV3 extends Omit<ParticleEffectProgram, 'format'> {
  readonly format: 'forgeax-vfx-program-4';
}

export interface ParticleEffectAssetV3
  extends Omit<ParticleEffectAsset, 'schemaVersion' | 'program'> {
  readonly schemaVersion: 3;
  readonly program: ParticleEffectProgramV3;
}
