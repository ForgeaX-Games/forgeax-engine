// @forgeax/engine-vfx-compiler - build-time code-first VFX compiler.

export type {
  ParticleEffectRootSourceV2,
  ParticleEffectSourceV2,
  ParticleEmitterSourceV2,
} from '@forgeax/engine-vfx';
export type {
  CookedParticleCodeEmitter,
  ParticleCodeCompileError,
  ParticleCodeCookError,
  ParticleCodeCookProduct,
  ParticleCodeEffectPayload,
  ParticleCodeModuleSet,
  ParticleCodeNativeCookInput,
  ParticleCodeProgram,
  ParticleCodeProgramArtifact,
  ParticleCodeProgramReflection,
} from './code-program.js';
export {
  cookParticleCodeEffect,
  cookParticleCodeProgram,
  createParticleCodeNativeCooker,
  PARTICLE_CODE_DEFAULT_MODULE,
  PARTICLE_CODE_PRELUDE,
  PARTICLE_CODE_PRELUDE_MODULE_ID,
  PARTICLE_CODE_PROGRAM_ARTIFACT_KEY,
  PARTICLE_CODE_PROGRAM_FORMAT,
} from './code-program.js';
