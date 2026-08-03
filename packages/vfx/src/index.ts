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
/** Load a cooked particle effect by GUID through the host AssetRegistry. */
export { loadParticleEffect } from './load-particle-effect.js';
export { particleEffectPackLoader } from './loader.js';
export type { ParticleEffectPlayerData } from './player.js';
/** ECS author intent: effect handle, playback, seed, and time scale. */
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
  ParticleSimulationSpace,
  ParticleSpacePose,
  ParticleSpaceResolvePhase,
  ParticleSpaceResolver,
  ParticleSpaceResolverError,
  ParticleSpaceResolverErrorCode,
  ParticleSpaceResolverErrorDetail,
  ParticleSpaceResolverInput,
  ParticleSpaceResolverResult,
} from './simulation/space-resolver.js';
export { createParticleSpaceError, transformParticlePoint } from './simulation/space-resolver.js';
export type {
  ParticleSimulationAssets,
  ParticleSimulationBatchSpace,
  ParticleSimulationEmitterObservation,
  ParticleSimulationEmitterStatus,
  ParticleSimulationObservation,
  ParticleSimulationPlayerInput,
  ParticleSimulationSelectedBackend,
  ParticleSimulationTelemetry,
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
export {
  createStockParticleCpuExecutorDefinitions,
  createStockParticleCpuExecutorRegistry,
  STOCK_PARTICLE_OPERATOR_MANIFEST,
  stockParticleOperatorKey,
} from './stock/cpu-executors.js';
export type {
  StockParticleOperatorKey,
  StockParticleOperatorKind,
  StockParticleOperatorManifestEntry,
  StockParticleOperatorStage,
  StockParticleParameterResult,
} from './stock/operator-manifest.js';
