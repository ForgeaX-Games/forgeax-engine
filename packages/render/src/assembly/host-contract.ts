import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { Result, RhiDevice, RhiError, ShaderModule } from '@forgeax/engine-rhi';
import type { RecoverFailure } from '../errors/recover';
import type { ObservationUnavailableError, RenderError } from '../errors/render';
import type { RenderFeature, RenderFeatureDiagnostics } from '../features/types';
import type { MeshMaterialBindingObservation } from '../mesh-material-bindings';
import type { FrameObservation, FrameObservationOptions } from '../record/frame';
import type {
  DrawOwnerOptions,
  FrameObservationRequest,
  FrameReceipt,
  FrameReceiptObservation,
  HealthSnapshot,
  RenderDebugOverlay,
  RendererError,
  RendererErrorListener,
  RendererLostListener,
  RenderFrameInput,
  RenderInspection,
  RenderProfile,
  RenderResult,
  RenderWorldLease,
} from '../render-contract';
import type { RenderSceneInspection } from '../render-system';

type RenderShaderModuleFactory = (
  device: RhiDevice,
  desc: { readonly label?: string | undefined; readonly code: string },
) => Promise<Result<ShaderModule, RhiError>>;

/** Package-local source projected to the sole public Renderer.subscribe channel. */
export type RendererHostEvent =
  | { readonly kind: 'error'; readonly error: RendererError }
  | { readonly kind: 'health'; readonly health: HealthSnapshot };

export type RendererHostEventListener = (event: RendererHostEvent) => void;

/**
 * Narrow assembly contract consumed by exposeRenderer and constructRendererHost.
 * Legacy diagnostics remain on RendererLegacyHostAdapter and cannot leak into
 * the public Renderer type.
 */
export interface RendererHostImplementation {
  attach(world: World): RenderResult<RenderWorldLease, RenderError>;
  setProfile(profile: RenderProfile): RenderResult<void, RenderError>;
  inspect(): RenderInspection;
  drawFrame(request: RenderFrameInput): RenderResult<FrameReceipt, RhiError | RenderError>;
  observe(
    receipt: FrameReceipt,
    request: FrameObservationRequest,
  ): Promise<RenderResult<FrameReceiptObservation, RenderError>>;
  releaseSurface(): RenderResult<void, RhiError>;
  restoreSurface(): RenderResult<void, RhiError>;
  recover(): Promise<Result<void, RecoverFailure>>;
  dispose(): RenderResult<void, RenderError>;
  /** @internal Single event source used to construct public Renderer.subscribe. */
  subscribeHostEvents(listener: RendererHostEventListener): () => void;

  readonly device: RhiDevice;
  /** @internal */
  readonly _internal_createShaderModule: RenderShaderModuleFactory;
  /** @internal */
  readonly _internal_setRenderOverlay: (overlay: RenderDebugOverlay | undefined) => void;
  readonly assetRegistry: AssetRegistry;
  readonly initialization: Promise<RenderResult<void, RhiError>>;
}

/**
 * @internal
 * Temporary package-local compatibility surface for unmigrated render tests
 * and producers. It is intentionally absent from RendererHostImplementation.
 */
export interface RendererLegacyHostAdapter {
  attachScene(world: World): RenderResult<void, RhiError>;
  detachScene(world: World): void;
  draw(
    worldsOrRequest: readonly World[] | RenderFrameInput,
    options?: DrawOwnerOptions,
  ): RenderResult<void | FrameReceipt, RhiError | RenderError>;
  observeCurrentFrame(
    options: FrameObservationOptions,
  ): Promise<RenderResult<FrameObservation, ObservationUnavailableError>>;
  onLost(listener: RendererLostListener): () => void;
  onError(listener: RendererErrorListener): () => void;
  health(): HealthSnapshot;
  readonly frustumStats: { readonly culled: number; readonly total: number };
  readonly visibilityStats: { readonly explicitlyHidden: number };
  readonly renderScene: RenderSceneInspection;
  readonly meshMaterialBindings: readonly MeshMaterialBindingObservation[];
  readonly perFramePassNames: readonly string[];
  renderFeatureDiagnostics(): readonly RenderFeatureDiagnostics[];
  installRenderFeature(feature: RenderFeature<unknown>): Promise<RenderResult<void, RenderError>>;
  uninstallRenderFeature(feature: RenderFeature<unknown>): Promise<RenderResult<void, RenderError>>;
  readonly bindGroupCounts: { readonly createBindGroup: number; readonly keys: readonly string[] };
}

/** @internal Concrete factory object before it is narrowed by exposeRenderer. */
export interface RendererAssemblyImplementation
  extends RendererHostImplementation,
    RendererLegacyHostAdapter {}
