// @forgeax/engine-vfx-compiler - build-time VFX public contract.

export type {
  ParticleEffectAsset,
  ParticleEmitterDefinition,
} from '@forgeax/engine-types';
export type {
  ParticleRuntimeBackendPlan,
  ParticleRuntimeEmitter,
  ParticleRuntimeProgram,
  ParticleRuntimeStageProgram,
  VfxAssetLoadDetail,
  VfxBatchInvalidDetail,
  VfxCause,
  VfxError,
  VfxErrorCode,
  VfxErrorDetailFor,
  VfxErrorFor,
  VfxOperatorBackendUnsupportedDetail,
  VfxOperatorUnknownDetail,
  VfxProgramInvalidDetail,
} from '@forgeax/engine-vfx';
export {
  PARTICLE_PROGRAM_ARTIFACT_KEY,
  PARTICLE_PROGRAM_FORMAT,
} from '@forgeax/engine-vfx';
export type {
  CanonicalParticleEmitter,
  CanonicalParticleProgram,
  ParticleEmitterOperatorPrograms,
  ParticleProgramArtifact,
  ParticleProgramInput,
} from './canonicalize.js';
export { canonicalizeParticleProgram } from './canonicalize.js';
export type { ParticleCookError } from './cook.js';
export {
  cookParticleEffect,
  cookParticleEffectProduct,
  createParticleEffectNativeCooker,
} from './cook.js';
export { PARTICLE_EFFECT_IMPORTER_KEY, particleEffectImporter } from './importer.js';
export type {
  ParticleBackend,
  ParticleBackendPlan,
  ParticleBackendPlanRequest,
  ParticleBackendPolicy,
  ParticleOperatorBackendUnsupportedDetail,
  ParticleOperatorCompiler,
  ParticleOperatorConflictDetail,
  ParticleOperatorDefinition,
  ParticleOperatorKey,
  ParticleOperatorParamsInvalidDetail,
  ParticleOperatorProgram,
  ParticleOperatorRegistryError,
  ParticleOperatorStage,
  ParticleOperatorUnknownDetail,
} from './operator-registry.js';
export { ParticleOperatorRegistry } from './operator-registry.js';
export { createStockParticleOperatorDefinitions } from './stock/compiler-definitions.js';
export type {
  StockParticlePairingDetail,
  StockParticlePairingError,
} from './stock/paired-registry.js';
export {
  createStockParticleOperatorRegistry,
  validateStockParticleOperatorPairing,
} from './stock/paired-registry.js';
