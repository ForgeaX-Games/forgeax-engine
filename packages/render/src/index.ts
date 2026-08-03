export * from './components/camera';
export * from './components/directional-light';
export { Instances, type InstancesData } from './components/instances';
export { Layer } from './components/layer';
export * from './components/light-helpers';
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
export * from './errors/index';
export * from './errors/recover';
/**
 * Public producer seam: RenderFeature, its narrow stage contexts, structured
 * diagnostics, graph contribution vocabulary, and prepared graphics facade.
 * This root declaration is the AI-discoverable API authority; host
 * construction details remain under the internal entry.
 */
export * from './features';
export * from './fullscreen-post-process-pass';
export { Materials } from './materials';
export * from './pipeline-errors';
export * from './post-process-errors';
export * from './render-graph-primitives';
export type { RenderPipeline, RenderPipelineData } from './render-pipeline';
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
  RenderPhaseEvent,
  RenderPhaseObserver,
  RenderPhaseSkipReason,
  RenderResult,
} from './renderer';
export { resolveDrawOwners } from './renderer';
export * from './surface-format';
