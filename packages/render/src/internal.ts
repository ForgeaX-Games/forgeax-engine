// Non-stable implementation seam for engine-owned consumers and tests.

export * from './authoring';
export * from './cluster-binner';
export * from './components/camera';
export * from './components/light-helpers';
export { createDebugDrawOnReady } from './debug-draw-glue';
export { createEngineMetrics } from './engine-metrics';
export * from './errors/index';
export * from './errors/recover';
export * from './extract/schema-readers';
export * from './features/host';
export {
  createRenderFeatureGraphicsPrepare,
  validateRenderFeatureGraphicsPass,
} from './features/prepared-graphics';
export type {
  RenderFeatureCapabilityMissingDetail,
  RenderFeatureCleanupFailure,
  RenderFeatureDrawRecordingFailedDetail,
  RenderFeatureErrorDetailByCode,
  RenderFeaturePassOrderConflictDetail,
  RenderFeaturePreparationFailedDetail,
  RenderFeaturePreparedStateMismatchDetail,
  RenderFeatureRegistrationConflictDetail,
  RenderFeatureStageFailedDetail,
} from './features/types';
export * from './fullscreen-post-process-pass';
export type { GpuResource } from './gpu-resource';
export { GpuBuffer, GpuTexture } from './gpu-resource';
export { GpuResourceStore } from './gpu-resource-store';
export * from './hdrp-buffers';
export * from './hdrp-pipeline';
export * from './ibl/IblPipelineCache';
export * from './ibl/skylight-bind-group';
export * from './index';
export * from './instance-buffer-cache';
export * from './lifecycle';
export * from './light-buffer-layout';
export * from './pbr-pipeline';
export * from './pipeline-builder';
export * from './pipeline-errors';
export * from './pipeline-spec';
export * from './post-process-errors';
export * from './prepare/schema-readers';
export * from './record/frame-snapshot';
export * from './record/frame-targets';
export * from './record/index';
export * from './record/main-pass-material';
export * from './record/skybox-post-pass';
export * from './record/view-ubo';
export * from './render-data';
export * from './render-graph-primitives';
export type { _InternalRenderPipelineContext } from './render-pipeline-context';
export * from './render-system';
export * from './render-system-extract';
export * from './render-system-fold';
export type { EngineEnvironmentErrorDetail } from './renderer/environment-error';
export { EngineEnvironmentError } from './renderer/environment-error';
export * from './renderer/renderer-factory';
export * from './scene-instances/post-spawn-resolve-joints';
export { collectSubtree } from './scene-utils/collect-subtree';
export * from './shadow-atlas';
export * from './ssao-buffers';
export * from './ssao-data';
export * from './surface-format';
export * from './systems/active-camera';
export * from './systems/pass-selector';
export * from './systems/skin-palette-allocator';
export * from './systems/transparent-sort-config';
export * from './tilemap-chunk-extract-system';
export { URP_PIPELINE_ID, urpPipeline } from './urp-pipeline';
