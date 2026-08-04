// @forgeax/engine-vfx-render - downstream public particle render boundary.
//
// AI users: import `createParticleRuntimeHost` from this entry, attach each
// host-provided World, and pass `host.feature` through the renderer's existing
// `features` option. Internal feature assembly, compiler symbols, and mutable
// simulation state are intentionally absent from this public barrel.

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
  createParticleRuntimeHost,
  type ParticleRuntimeHost,
  type ParticleRuntimeHostFailure,
  type ParticleRuntimeHostOptions,
  type ParticleRuntimeWorldInput,
} from './host/particle-runtime-host.js';
export type {
  ParticleRuntimeHostAttachResult,
  ParticleRuntimeHostAttachState,
  ParticleRuntimeHostDetachResult,
  ParticleRuntimeHostDetachState,
  ParticleRuntimeHostError,
  ParticleRuntimeHostErrorCode,
  ParticleRuntimeHostResult,
} from './host/particle-runtime-readiness.js';
export {
  /** Resolve local particle output against the host scene World. */
  type ParticleSceneSpaceResolverOptions,
  particleSceneSpaceResolver,
} from './scene/particle-scene-space.js';
