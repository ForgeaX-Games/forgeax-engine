// @forgeax/engine-types - runtime-safe VFX asset vocabulary.

/** Runtime-ready definition for one cooked particle emitter. */
export interface ParticleEmitterDefinition {
  readonly id: string;
  readonly capacity: number;
}

/** Cooked particle effect payload shared by asset and ECS consumers. */
export interface ParticleEffectAsset {
  readonly kind: 'particle-effect';
  readonly schemaVersion: 1;
  readonly emitters: readonly ParticleEmitterDefinition[];
}
