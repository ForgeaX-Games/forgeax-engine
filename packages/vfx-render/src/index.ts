// @forgeax/engine-vfx-render - GPU particle execution and rendering.

export type { ParticleRenderCamera, ParticleRenderCameraSource } from './feature/camera.js';
export { gpuParticleRenderFeature } from './feature/gpu-particle-feature.js';
export { PARTICLE_SHADER_IDENTIFIERS } from './feature/particle-resources.js';
export type {
  VfxRuntimeHost,
  VfxRuntimeHostError,
  VfxRuntimeHostOptions,
} from './host/vfx-runtime-host.js';
export { createVfxRuntimeHost } from './host/vfx-runtime-host.js';
