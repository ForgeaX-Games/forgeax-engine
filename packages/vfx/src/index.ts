// @forgeax/engine-vfx - runtime-safe code-first GPU VFX contract.

export type { ParticleEffectAsset, ParticleEmitterDefinition } from '@forgeax/engine-types';
export type {
  ParticleBoundsSource,
  ParticleChannelOverflowPolicy,
  ParticleChannelSource,
  ParticleCodeSourceError,
  ParticleCodeSourceInvalidDetail,
  ParticleEffectRootSourceV2,
  ParticleEffectSourceV2,
  ParticleEmitterSourceV2,
  ParticleEventSource,
  ParticleRendererOverflowPolicy,
  ParticleRendererSorting,
  ParticleRendererSource,
  ParticleStageDomain,
  ParticleStageResourceAccess,
  ParticleStageResourceSource,
  ParticleStageSource,
} from './code-source.js';
export {
  defineParticleEffectSourceV2,
  PARTICLE_CODE_DEFAULT_MODULE_ID,
  PARTICLE_STAGE_RESOURCE_NAMES,
  parseParticleEffectSourceV2,
  parseVfxStageDeclarations,
} from './code-source.js';
export type {
  VfxDataInterfaceBindingType,
  VfxDataInterfaceError,
  VfxDataInterfaceErrorDetail,
  VfxDataInterfaceKind,
  VfxDataInterfaceLifetime,
  VfxDataInterfaceProvider,
  VfxDataInterfaceRequirement,
  VfxDataInterfaceResolution,
  VfxDataInterfaceResource,
  VfxDataInterfaceToken,
} from './data-interface.js';
export { resolveVfxDataInterfaces } from './data-interface.js';
export type {
  VfxEffectContract,
  VfxEffectContractError,
  VfxEffectContractErrorDetail,
  VfxEffectReflection,
  VfxReflectedField,
  VfxReflectedStruct,
  VfxValue,
  VfxValueMap,
  VfxValueType,
} from './effect-contract.js';
export { createVfxEffectContract, validateVfxEffectValues } from './effect-contract.js';
export type { VfxGpuAssetError } from './gpu-loader.js';
export { loadVfxGpuEffect, vfxGpuEffectPackLoader } from './gpu-loader.js';
export type {
  VfxGpuEffectAsset,
  VfxGpuEmitterProgram,
  VfxGpuProgram,
  VfxGpuProgramReflection,
  VfxGpuStageReflection,
} from './gpu-program.js';
export { VFX_GPU_PROGRAM_ARTIFACT_KEY, VFX_GPU_PROGRAM_FORMAT } from './gpu-program.js';
export type {
  VfxGpuRuntimeDiagnostic,
  VfxGpuRuntimeOptions,
  VfxGpuTickIntent,
} from './gpu-runtime.js';
export {
  createVfxInspectSnapshot,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from './gpu-runtime.js';
export type {
  VfxChannelCounters,
  VfxChannelInput,
  VfxChannelPayload,
  VfxInstanceCommit,
  VfxInstanceCommitOptions,
  VfxInstanceError,
  VfxInstanceOptions,
  VfxInstanceParent,
  VfxReplayInput,
} from './instance.js';
export {
  createParticleEffectInstance,
  ParticleEffectInstance,
} from './instance.js';
export type { ParticleEffectPlayerData } from './player.js';
export { ParticleEffectPlayer } from './player.js';
