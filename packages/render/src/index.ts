export type { CameraProjection, Tonemap } from './components/camera';
export {
  ANTIALIAS_FXAA,
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  cameraProjectionFromF32,
  orthographic,
  perspective,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_CINEON,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_NONE,
  TONEMAP_REINHARD,
  TONEMAP_REINHARD_EXTENDED,
  tonemapFromF32,
  tonemapToU32,
} from './components/camera';
export * from './components/directional-light';
export { Instances, type InstancesData } from './components/instances';
export { Layer } from './components/layer';
export * from './components/mesh-filter';
export * from './components/mesh-renderer';
export { PointLight } from './components/point-light';
export { PointLightShadow } from './components/point-light-shadow';
export { PostProcessParams } from './components/post-process-params';
export {
  SceneInstance,
  type SceneInstanceOverrideRecord,
  type SceneInstanceState,
} from './components/scene-instance';
export {
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  type SkyboxMode,
  skyboxModeFromF32,
} from './components/skybox-background';
export { Skylight } from './components/skylight';
export { SortKey } from './components/sort-key';
export { SpotLight } from './components/spot-light';
export {
  Visibility,
  type VisibilityState,
  VisibilityStateValue,
  visibilityStateFromU32,
} from './components/visibility';
export {
  type EquirectProjectionFailedDetail,
  ObservationUnavailableError,
  type RenderError,
  type RenderErrorCode,
  RenderFeatureCapabilityMissingError,
  RenderFeatureDrawRecordingFailedError,
  RenderFeaturePassOrderConflictError,
  RenderFeaturePreparationFailedError,
  RenderFeaturePreparedStateMismatchError,
  RenderFeatureRegistrationConflictError,
  RenderFeatureStageFailedError,
} from './errors/index';
export { RecoverError, type RecoverErrorCode } from './errors/recover';
export {
  resolveVisibility,
  type VisibilityResolution,
  type VisibilitySnapshot,
} from './extract/visibility';
/**
 * Public producer seam: RenderFeature, its narrow stage contexts, structured
 * diagnostics, graph contribution vocabulary, and prepared graphics facade.
 * This root declaration is the AI-discoverable API authority; host
 * construction details remain under the internal entry.
 */
export * from './features';
export { Materials } from './materials';
export { PipelineError, type PipelineErrorCode } from './pipeline-errors';
export { PostProcessError, type PostProcessErrorCode } from './post-process-errors';
export {
  type FrameObservation,
  type FrameObservationMetadata,
  type FrameObservationOptions,
  type FrameObservationReadback,
  type FrameObservationSource,
  observeCurrentFrame,
} from './record/frame-observation';
export {
  createMembershipTiming,
  MEMBERSHIP_TIMING_REASON_CODES,
  MEMBERSHIP_TIMING_REASON_MAPPING,
  MEMBERSHIP_TIMING_REASON_SCHEMA,
  type MembershipTimingController,
  MembershipTimingError,
  type MembershipTimingGpuOutputSource,
  type MembershipTimingGpuReport,
  type MembershipTimingOptions,
  type MembershipTimingReasonCode,
  type MembershipTimingReport,
} from './record/membership-timing';
export type {
  AddBloomPassesOptions,
  AddFullscreenPassOptions,
  AddScenePassOptions,
  AddShadowPassOptions,
  AddSkyboxPassOptions,
  AddSpotShadowPassOptions,
  AddSsaoPassesOptions,
  AddSsaoPassesParams,
  AddTonemapPassOptions,
} from './render-graph-primitives';
export {
  addBloomPasses,
  addFullscreenPass,
  addPointShadowPass,
  addScenePass,
  addShadowPass,
  addSkyboxPass,
  addSpotShadowPass,
  addSsaoPasses,
  addTonemapPass,
  TONEMAP_POST_PROCESS_ID,
} from './render-graph-primitives';
export {
  type RenderColorDomain,
  type RenderFeatureTargetContext,
  type RenderPipeline,
  type RenderPipelineData,
  resolvePostColorDomainContract,
  resolveToneOutputContract,
  type ToneOutputContract,
} from './render-pipeline';
export type { RenderPipelineContext } from './render-pipeline-context';
export type {
  DrawOwnerOptions,
  HealthChangeListener,
  HealthDetailDeviceLost,
  HealthDetailInternalFault,
  HealthReason,
  HealthSnapshot,
  Renderer,
  RendererBackend,
  RendererError,
  RendererErrorListener,
  RendererInstallError,
  RendererLostInfo,
  RendererLostListener,
  RendererOptions,
  RenderPhase,
  RenderPhaseSkipReason,
  RenderResult,
} from './renderer';
export { RENDER_PHASE_CATALOG, resolveDrawOwners } from './renderer';
