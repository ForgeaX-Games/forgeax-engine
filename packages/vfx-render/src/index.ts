// @forgeax/engine-vfx-render - GPU particle execution and rendering.

export type { ParticleRenderCamera, ParticleRenderCameraSource } from './feature/camera.js';
export {
  encodeEventInputs,
  eventCapacity,
  eventCounterData,
  eventInputCapacity,
  VFX_EVENT_BYTES,
  VFX_EVENT_COUNTER_BYTES,
  VFX_EVENT_INPUT_BYTES,
} from './feature/event-resources.js';
export {
  createVfxRenderInspectSnapshot,
  gpuParticleRenderFeature,
  resolveBillboardAdvancedState,
  topologyRecoveryHint,
} from './feature/gpu-particle-feature.js';
export {
  createTopologyResourcePlan,
  PARTICLE_SHADER_IDENTIFIERS,
  topologyCapacitySnapshot,
} from './feature/particle-resources.js';
export type {
  VfxStagePlanError,
  VfxStagePlanObservation,
  VfxStageReadiness,
  VfxStageRecovery,
  VfxValidatedStage,
  VfxValidatedStagePlan,
} from './feature/stage-plan.js';
export {
  observeStagePlan,
  stageDispatches,
  stageRecoveryReadiness,
  validatedStagePlan,
} from './feature/stage-plan.js';
export type {
  VfxDataInterfaceAvailabilitySource,
  VfxDataInterfaceProvider,
  VfxDataInterfaceRegistry,
} from './host/data-interface-providers.js';
export {
  createCameraProvider,
  createSceneDepthProvider,
  createVfxDataInterfaceRegistry,
} from './host/data-interface-providers.js';
export type {
  VfxRuntimeHost,
  VfxRuntimeHostError,
  VfxRuntimeHostOptions,
} from './host/vfx-runtime-host.js';
export { createVfxRuntimeHost } from './host/vfx-runtime-host.js';
