// @forgeax/engine-vfx - runtime-safe VFX public contract.

export type {
  ParticleEffectAsset,
  ParticleEmitterDefinition,
} from '@forgeax/engine-types';
export type {
  ParticleOperatorKey,
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
  VfxSimulationCapabilityUnavailableDetail,
  VfxSimulationExecutionFailedDetail,
  VfxSimulationOutputUnavailableDetail,
  VfxSimulationPlayerInvalidDetail,
} from './errors.js';

export { vfxError } from './errors.js';
export { loadParticleEffect } from './load-particle-effect.js';
export { particleEffectPackLoader } from './loader.js';
export type { ParticleEffectPlayerData } from './player.js';
export { ParticleEffectPlayer } from './player.js';
export type {
  ParticleBillboardAttributes,
  ParticleBillboardBatch,
  ParticleMeshAttributes,
  ParticleMeshBatch,
  ParticleOutputBatch,
  ParticleRenderBatch,
} from './render-batch.js';
export {
  createParticleRenderBatch,
  validateParticleRenderBatch,
} from './render-batch.js';
export type {
  LoadedParticleEffect,
  ParticleRuntimeBackendPlan,
  ParticleRuntimeEmitter,
  ParticleRuntimeProgram,
  ParticleRuntimeStageProgram,
} from './runtime-program.js';
export {
  PARTICLE_PROGRAM_ARTIFACT_KEY,
  PARTICLE_PROGRAM_FORMAT,
} from './runtime-program.js';
export type {
  ParticleCpuExecutorDefinition,
  ParticleCpuExecutorEntry,
} from './simulation/cpu-executor-registry.js';
export {
  ParticleCpuExecutorRegistry,
  particleCpuExecutorKey,
} from './simulation/cpu-executor-registry.js';
export {
  type ParticleSimulationPluginOptions,
  particleSimulationPlugin,
} from './simulation/plugin.js';
export { PARTICLE_SIMULATION_RESOURCE_KEY, ParticleSimulation } from './simulation/resource.js';
export type {
  ParticleSimulationAssets,
  ParticleSimulationEmitterObservation,
  ParticleSimulationEmitterStatus,
  ParticleSimulationObservation,
  ParticleSimulationPlayerInput,
} from './simulation/types.js';
export type {
  ParticleBackend,
  ParticleBackendPolicy,
  ParticleBounds,
  ParticleCurve,
  ParticleCurvePoint,
  ParticleEffectSource,
  ParticleEmitterSchedule,
  ParticleEmitterSource,
  ParticleGradient,
  ParticleGradientStop,
  ParticleOperatorSource,
  ParticleOperatorStage,
  ParticleOutputSource,
  ParticleSourceError,
  ParticleSourceInvalidDetail,
} from './source.js';
export {
  defineParticleEffectSource,
  normalizeParticleEffectSource,
  parseParticleEffectSource,
  serializeParticleEffectSource,
} from './source.js';
