// Non-stable implementation seam for engine-owned consumers and tests.

export {
  type ResolvedTilesetRuntime,
  resolveTilesetRuntime,
  type TilesetAtlasLookup,
  type TilesetRuntimeError,
  type TilesetRuntimeErrorCode,
} from '@forgeax/engine-assets-runtime';
export { DeviceScope } from './device/device-scope';
export { createLightResourceUnavailable } from './errors/render';
export {
  deriveLtcResourcePlan,
  type LtcResourcePlan,
} from './prepare/extended-lighting/ltc-resources';
export {
  deriveExtendedLightingCapability,
  EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES,
  type ExtendedLightingCapabilityResult,
  type ExtendedLightingResourceCandidate,
  extendedLightingSampledTextureCapacityAvailable,
} from './prepare/extended-lighting/resources';
export {
  createExtendedLightingState,
  type ExtendedLightingState,
  projectExtendedLightingInspection,
  promoteExtendedLightingCandidate,
  recordExtendedLightingFailure,
} from './prepare/extended-lighting/state';
export {
  buildRaySurfaceScene,
  type RaySurfaceInstance,
  type RaySurfaceScene,
} from './raytracing/attributes';
export type { SurfaceViewProjection } from './raytracing/capture-view';
export {
  CARD_LOOKUP_STRIDE,
  CardLookupStatus,
  createSdfCardLookup,
  type SdfCardLookup,
} from './raytracing/card-lookup';
export {
  createDiffuseGi,
  type DiffuseGi,
  type DiffuseGiSettings,
  GI_PIXEL_STRIDE,
  GI_PROBE_SAMPLE_STRIDE,
  GI_SURFACE_STRIDE,
  GiStatus,
} from './raytracing/diffuse-gi';
export { createRayDisplay, type RayDisplayMode } from './raytracing/display';
export {
  createGlobalSdfCardLookup,
  GLOBAL_CARD_CANDIDATE_STRIDE,
  GlobalCardCandidateFlags,
  type GlobalSdfCardLookup,
} from './raytracing/global-card-lookup';
export {
  createGlobalSdfComposition,
  GLOBAL_SDF_VOXEL_STRIDE,
  type GlobalSdfComposition,
  type GlobalSdfGrid,
  GlobalSdfVoxelStatus,
} from './raytracing/global-sdf';
export {
  createGlobalSdfQuery,
  GLOBAL_SDF_HIT_STRIDE,
  type GlobalSdfQuery,
  GlobalSdfQueryStatus,
} from './raytracing/global-sdf-query';
export {
  createRayPathTracer,
  createSubmittedRayPathTracer,
  type RayPathCamera,
  type RayPathInitialRay,
  type RayPathMaterial,
  type RayPathSettings,
  type RayPathTracer,
} from './raytracing/path-tracer';
export { createRayReferenceQuery, type RayReferenceQuery } from './raytracing/query';
export { createRasterRayGenerator, type RasterRayInputs } from './raytracing/raster-source';
export {
  buildRayReferenceScene,
  packReferenceRays,
  type RayMeshInstance,
  type RayReferenceError,
  type RayReferenceScene,
  type ReferenceHit,
  type ReferenceRay,
  traceReferenceRay,
} from './raytracing/scene';
export {
  createSdfQuery,
  type SdfMeshInstance,
  type SdfQuery,
  type SdfQueryOptions,
  SdfQueryStatus,
} from './raytracing/sdf-query';
export {
  CARD_PLANES,
  createSurfaceCapture,
  type SurfaceCapture,
  type SurfaceCardSource,
} from './raytracing/surface-cards';
export {
  type GraphTargetCaptureReadbackValidation,
  validateGraphTargetCaptureReadback,
} from './record/frame-snapshot';
export {
  buildRectAreaWorldFrame,
  rectAreaFacesPoint,
} from './render-system-extract';
export {
  admitProbeContributors,
  blendLightProbes,
  PROBE_MAX_CONTRIBUTORS,
  scaledProbeWeight,
} from './scene/probe-blend';
export {
  createVisibilityBudget,
  type VisibilityBudget,
} from './scene/visibility/budget';
export {
  type OcclusionRuntimeTestHooks,
  setOcclusionRuntimeTestHooks,
} from './scene/visibility/occlusion-runtime';
export {
  createSsrHistoryOwner,
  SSR_HISTORY_FORMAT,
  type SsrHistoryCandidate,
  type SsrHistoryError,
  type SsrHistoryFailureStage,
  type SsrHistoryInspection,
  SsrHistoryOwner,
  type SsrHistoryResetReason,
  type SsrHistoryResources,
  type SsrHistorySlot,
  type SsrHistoryState,
} from './ssr/history';
export { estimateSsrSpatialMemory } from './ssr/resources';
export {
  createSsrTemporalConsumer,
  type SsrTemporalCandidate,
  SsrTemporalConsumer,
  type SsrTemporalError,
  type SsrTemporalExecutionError,
  type SsrTemporalInspection,
} from './ssr/temporal';
export { TemporalFrameCoordinator } from './temporal/frame-coordinator';
