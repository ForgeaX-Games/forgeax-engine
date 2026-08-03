// @forgeax/engine-vfx-render - downstream public particle render boundary.

export {
  createParticleRenderError,
  PARTICLE_RENDER_ERROR_CODES,
  type ParticleRenderDiagnostics,
  type ParticleRenderError,
  type ParticleRenderErrorCode,
  type ParticleRenderErrorDetail,
  type ParticleRenderErrorDetailByCode,
  type ParticleRenderReadiness,
} from './errors.js';
export {
  collectParticleRenderBuckets,
  type ParticleRenderBucket,
  type ParticleRenderBucketKey,
  particleRenderBucketKey,
  particleRenderBucketKeysEqual,
} from './feature/buckets.js';
export type {
  ParticleRenderCamera,
  ParticleRenderCameraSource,
  ParticleRenderFeature,
  ParticleRenderFeatureFrameData,
  ParticleRenderFeatureOptions,
  ParticleRenderObservationSource,
} from './feature/particle-render-feature.js';
export type { ParticlePreparedState } from './feature/prepared-state.js';
/** Stable shader identities and the production particle RenderFeature producer. */
export { PARTICLE_SHADER_IDENTIFIERS, particleRenderFeature } from './feature/prepared-state.js';
export {
  /** Resolve local particle output against the host scene World. */
  type ParticleSceneSpaceResolverOptions,
  particleSceneSpaceResolver,
} from './scene/particle-scene-space.js';
