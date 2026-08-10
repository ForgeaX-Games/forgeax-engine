// @forgeax/engine-vfx - runtime-safe code-first GPU VFX contract.

export type { ParticleEffectAsset, ParticleEmitterDefinition } from '@forgeax/engine-types';
export type {
  ParticleBoundsSource,
  ParticleCodeSourceError,
  ParticleCodeSourceInvalidDetail,
  ParticleEffectRootSourceV2,
  ParticleEffectSourceV2,
  ParticleEmitterSourceV2,
  ParticleRendererSource,
} from './code-source.js';
export {
  defineParticleEffectSourceV2,
  PARTICLE_CODE_DEFAULT_MODULE_ID,
  parseParticleEffectSourceV2,
} from './code-source.js';
export type { VfxGpuAssetError } from './gpu-loader.js';
export { loadVfxGpuEffect, vfxGpuEffectPackLoader } from './gpu-loader.js';
export type {
  VfxGpuEffectAsset,
  VfxGpuEmitterProgram,
  VfxGpuProgram,
  VfxGpuProgramReflection,
} from './gpu-program.js';
export { VFX_GPU_PROGRAM_ARTIFACT_KEY, VFX_GPU_PROGRAM_FORMAT } from './gpu-program.js';
export type {
  VfxGpuRuntimeDiagnostic,
  VfxGpuRuntimeOptions,
  VfxGpuTickIntent,
} from './gpu-runtime.js';
export {
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from './gpu-runtime.js';
export type { ParticleEffectPlayerData } from './player.js';
export { ParticleEffectPlayer } from './player.js';
