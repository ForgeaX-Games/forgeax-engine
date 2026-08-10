/**
 * Public RenderFeature index. The three modules are the machine-readable
 * declaration route: graph contribution, prepared graphics, and lifecycle
 * types. Host construction remains outside this barrel.
 */
export type {
  RenderFeatureContributionPass,
  RenderFeatureContributionResource,
  RenderFeatureContributionStaging,
  RenderFeatureGraphComposition,
  RenderFeatureGraphContribution,
  RenderFeaturePassDependency,
  RenderFeaturePassOptions,
} from './graph-contribution';
export { createRenderFeatureContributionStaging } from './graph-contribution';
export type {
  RenderFeatureGpuBindingsDescriptor,
  RenderFeatureGpuBindingsRef,
  RenderFeatureGpuBufferDescriptor,
  RenderFeatureGpuBufferRef,
  RenderFeatureGpuBufferUsage,
  RenderFeatureGpuComputePassDescriptor,
  RenderFeatureGpuDispatch,
  RenderFeatureGpuPrepare,
  RenderFeatureGpuProgramDescriptor,
  RenderFeatureGpuProgramRef,
} from './prepared-gpu-work';
export type {
  PreparedKind,
  RenderFeatureBindingsDescriptor,
  RenderFeatureColorAttachment,
  RenderFeatureDepthStencilAttachment,
  RenderFeatureDrawCommand,
  RenderFeatureDrawRecord,
  RenderFeatureGraphicsContributionStaging,
  RenderFeatureGraphicsPassAttachments,
  RenderFeatureGraphicsPassDescriptor,
  RenderFeatureGraphicsPrepare,
  RenderFeatureIndexDataBinding,
  RenderFeatureIndexDataDescriptor,
  RenderFeatureIndexedDrawCommand,
  RenderFeaturePipelineDescriptor,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
  RenderFeatureValidatedGraphicsPass,
  RenderFeatureVertexDataBinding,
  RenderFeatureVertexDataDescriptor,
} from './prepared-graphics';
export { RENDER_FEATURE_VERTEX_LAYOUTS } from './prepared-graphics';
export type {
  RenderFeatureTargetHandle,
  RenderFeatureTargetInput,
  RenderFeatureTargetKind,
} from './targets';
export {
  createRenderFeatureTarget,
  isRenderFeatureTargetHandle,
  renderFeatureAttachmentResource,
} from './targets';
export type {
  RenderFeature,
  RenderFeatureCapabilityKey,
  RenderFeatureContributeContext,
  RenderFeatureDiagnostics,
  RenderFeatureErrorCode,
  RenderFeatureErrorDescriptor,
  RenderFeatureErrorSink,
  RenderFeatureExtractContext,
  RenderFeatureFrameIdentity,
  RenderFeatureHiddenEntityReport,
  RenderFeaturePassContext,
  RenderFeaturePrepareContext,
  RenderFeatureRecoverInput,
  RenderFeatureRecovery,
  RenderFeatureResourceHandle,
  RenderFeatureStage,
  RenderFeatureStatus,
  RenderFeatureWorldVisibilitySnapshot,
} from './types';
