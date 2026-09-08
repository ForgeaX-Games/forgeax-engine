// @forgeax/engine-render — AI-facing render vocabulary.
//
// The root is deliberately small: ECS render components, grouped closed
// values, the renderer lifecycle/receipt contract, and the declarative
// RenderFeature plan. Graph builders, prepared GPU state, pipeline
// implementations, builtin feature factories, and diagnostic class names are
// owner-local implementation details.

export {
  materialContribution,
  renderPipelineContribution,
  samplerContribution,
} from './assets/asset-decoders';

// ECS render vocabulary and grouped closed values.
export type { Antialias, BloomEnabled, CameraProjection, Tonemap } from './components/camera';
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
} from './components/camera';
export * from './components/directional-light';
export { Instances, type InstancesData } from './components/instances';
export { Layer } from './components/layer';
export { Lines } from './components/lines';
export * from './components/mesh-filter';
export * from './components/mesh-renderer';
export { PointLight } from './components/point-light';
export { PointLightShadow } from './components/point-light-shadow';
export {
  type PointShape,
  PointShapeValue,
  Points,
  pointShapeFromU32,
} from './components/points';
export { PostProcessParams } from './components/post-process-params';
export { SceneInstance } from './components/scene-instance';
export {
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  type SkyboxMode,
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
// Public structured operation failure union. Concrete error classes stay
// behind the Renderer Result/event boundary.
export type { RenderError, RenderErrorCode } from './errors/render';
export {
  resolveVisibility,
  type VisibilityResolution,
  type VisibilitySnapshot,
} from './extract/visibility';
export type {
  RenderFeatureLogicalTarget,
  RenderFeatureMaterialShaderBindingContract,
  RenderFeaturePassDeclaration,
  RenderFeaturePlan,
  RenderFeaturePlanContext,
  RenderFeatureResourceDeclaration,
} from './features/plan';
// Minimal declarative extension contract. Implementations use relative
// imports; the root does not expose prepared state, graph projectors, target
// handles, or builtin feature factories.
export type {
  RenderFeature,
  RenderFeatureCapabilityKey,
  RenderFeatureDiagnostics,
  RenderFeatureErrorDescriptor,
  RenderFeatureExtractContext,
  RenderFeatureHiddenEntityReport,
  RenderFeatureStatus,
  RenderFeatureWorldVisibilitySnapshot,
} from './features/types';
export { Materials } from './materials';
// The host-facing default is a stable profile value; implementation-only
// pipeline helpers remain behind the package boundary.
export { DEFAULT_STANDARD_PROFILE } from './pipeline/standard-profile';
export { renderComponentsPlugin } from './plugin';
export {
  admitPointsLines,
  type LinesStyleInput,
  type PointsLinesAdmission,
  type PointsLinesAdmissionError,
  type PointsLinesAdmissionInput,
  type PointsLinesAdmissionLimits,
  type PointsStyleInput,
} from './points-lines/admission';
export type { PointsLinesInspection } from './points-lines/inspection';
// Runtime contract: leases, frame receipts, detached inspection, profile,
// lifecycle state, and the single renderer event stream.
export type {
  FrameCamera,
  FrameEnvironment,
  FrameObservationRequest,
  FrameReceipt,
  FrameReceiptObservation,
  Renderer,
  RendererEvent,
  RendererOptions,
  RendererState,
  RenderFrameInput,
  RenderInspection,
  RenderProfile,
  RenderResult,
  RenderWorldLease,
} from './render-contract';
export { RENDER_PHASE_CATALOG } from './render-contract';
