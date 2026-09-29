// @forgeax/engine-render — WebGPU renderer lifecycle/frame interpreter.
// Runtime selects the backend; structured RHI errors and browser isolation stay intact.
import {
  AssetRegistry,
  adaptDynamicTextureDevice,
  DynamicTextureStore,
} from '@forgeax/engine-assets-runtime';
import { audioLoader } from '@forgeax/engine-audio-webaudio';
import type { World } from '@forgeax/engine-ecs';
import { createRenderReadLease, type RenderReadLease } from '@forgeax/engine-ecs/projection';
import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type {
  BindGroupLayout,
  PipelineLayout,
  RenderPipeline,
  Result,
  RhiCanvasContext,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError, validateDrawArgs } from '@forgeax/engine-rhi';
import type { PipelineGroup2Contract } from '@forgeax/engine-shader';
import {
  findVariantByKey,
  type MaterialShaderEntry,
  type MaterialShaderManifestEntry,
  ShaderCatalog,
  standardPhysicalTextureFields,
} from '@forgeax/engine-shader';
import type {
  MaterialRenderState,
  ParamSchemaEntry,
  PassKind,
  PrimitiveTopology,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import { ProjectedDecalInvalidError } from '../decals/component';
import {
  materialShadersSamplePointShadows,
  projectPointShadowInspection,
} from '../point-shadow-inspection';
import { type PublishedRenderFrameInput, RenderPublicationError } from '../publication/contract';
import { installPublicationPrograms } from '../publication/programs';
import { type PreparedRenderPublication, RenderPublicationReceiver } from '../publication/receiver';
import type { RenderSystemInternals } from '../record/render-context';
import { isFrameObservationDomain } from '../render-contract';
import { registerRenderSourceSystems } from '../scene/source-systems';
import { createCameraViews } from './camera-views';
import { transmissionBackdropAvailable } from './device-feature-admission';

export type { MaterialShaderManifestEntry } from '@forgeax/engine-shader';

import { GpuResidencyCache } from '../device/gpu-residency';
import { createEngineMetrics } from '../engine-metrics';
import { createRecoveryFailedError, RecoverError, type RecoverFailure } from '../errors/recover';
import {
  CameraViewInvalidError,
  FrameReceiptStaleError,
  type RenderError,
  RendererContractFailureError,
  type RendererOperationCause,
  RendererOperationError,
  RenderFeatureCapabilityMissingError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import {
  dofInspection,
  registerDepthOfFieldBuiltins,
} from '../features/depth-of-field/depth-of-field-assembly';
import { createRenderFeatureHost } from '../features/host';
import { motionBlurDrawOptions } from '../features/motion-blur/motion-blur-runtime';
import { RENDER_FEATURE_VERTEX_LAYOUTS } from '../features/prepared-graphics';
import type { RenderFeature, RenderFeatureShaderModuleMode } from '../features/types';
import {
  type PostProcessShaderEntry,
  postProcessShaderModuleLabel,
} from '../fullscreen-post-process-pass';
import { GPU_SHADER_STAGE_FRAGMENT, GPU_SHADER_STAGE_VERTEX } from '../gpu-stage';
import { type BloomInspection, emptyBloomInspection } from '../inspection-types';
import { DeviceScope } from '../lifecycle';
import {
  createHdrpBindGroupLayoutDescriptor,
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrMaterialShader,
  SKIN_MATERIAL_SHADER_ID,
} from '../pbr-pipeline';
import { registerSingleLayerMediumBuiltins } from '../pipeline/single-layer-medium-passes';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import { buildPipelineForMaterialShader } from '../pipeline-builder';
import {
  buildBindGroupLayoutDescriptor,
  cacheKeyOf,
  colorFormatsForPassKind,
  type PipelineSpec,
  PipelineSpecError,
  passKindPolicyTable,
} from '../pipeline-spec';
import type { ExtendedLightingResourceCandidate } from '../prepare/extended-lighting/resources';
import {
  COOKIE_MATRIX_BYTES,
  COOKIE_SLICE_MIP_CHAIN_BYTES,
  deriveExtendedLightingCapability,
  EXTENDED_LIGHTING_TOPOLOGY,
  IES_SLICE_HEIGHT,
  IES_SLICE_WIDTH,
} from '../prepare/extended-lighting/resources';
import {
  createExtendedLightingState,
  projectExtendedLightingInspection,
  promoteExtendedLightingCandidate,
} from '../prepare/extended-lighting/state';
import type { FrameObservationOptions } from '../record/frame';
import type { GpuPassTimingReason } from '../record/gpu-pass-timing/errors.js';
import {
  createGpuPassTimingSession,
  DEFAULT_GPU_PASS_TIMING_OPTIONS,
  type GpuPassTimingCapture,
  type GpuPassTimingObservation,
  type GpuPassTimingSession,
} from '../record/gpu-pass-timing/index.js';
import { GpuTimingCapture, type VolumeTimingObservation } from '../record/gpu-timing';
import type {
  AtmosphereShaderSources,
  DepthPyramidShaderSources,
  DrawOwnerOptions,
  FrameObservationDomain,
  FrameObservationRequest,
  FrameReceipt,
  FrameReceiptObservation,
  HealthSnapshot,
  RendererErrorListener,
  RendererLostListener,
  RendererOptions,
  RenderFrameInput,
  RenderInspection,
  RenderProfile,
  RenderResult,
  RenderWorldLease,
  SsrShaderSources,
  VolumetricFogShaderSources,
} from '../render-contract';
import { FXAA_POST_PROCESS_ID, STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from '../render-contract';
import {
  attachGpuPassTimingSession,
  createRenderSystem,
  type PipelineState,
  type RecoveryGraphCandidate,
  type RecoveryPostProcessResources,
  type RecoveryRootBundle,
  type RenderSystem,
} from '../render-system';
import { createGpuPassTimingObservationStore, observeGpuPassTimingDisabled } from '../renderer.js';
import { postSpawnResolveJoints } from '../scene-instances/post-spawn-resolve-joints';
import type { RenderTarget } from '../targets/contracts';
import { registerAnalyticFogPostProcess } from './analytic-fog-registration';
import type { RhiBackendPack } from './backend-contract';
import { inspectBarrelDistortion } from './barrel-distortion-inspection';
import type { BundlerOptions } from './bundler-contract';
import { rejectZeroCanvasSize } from './canvas-draw-guard';
import { createRendererDynamicGeometryController } from './dynamic-geometry-host';
import { registerFxaaPostProcess } from './fxaa-registration';
import type { RendererAssemblyImplementation } from './host-contract';
import { observeLodOcclusionForReceipt } from './lod-observation';
import {
  isEngineOwnedMaterialShader,
  resolveMaterialPipelineBindGroups,
  resolveMaterialPipelineGroup2Contract,
  resolveMaterialPipelineShaderId,
  resolveMaterialPipelineVertexEntry,
  resolveRendererMaterialShaderArtifact,
} from './material/pipeline-helpers';
import {
  allowsUnlitPreparedFallback,
  invokeDeviceCreateShaderModule,
  isSharedMaterialUserRegionCompatible,
  type LayoutKind,
  type MaterialShaderBindingContract,
  makeShaderDeviceAdapter,
  normalizeMaterialShaderVariantSet,
  prepareLowLimitMaterialShaderEntry,
  prepareMaterialShaders,
  requiresPreparedMaterialShader,
  resolveMaterialShaderBackendArtifactKey,
  resolveMaterialShaderBindingContract,
  resolveMaterialShaderUvSetCount,
  resolveMaterialShaderVariantSet,
  resolveMaterialShaderVertexInputContract,
  type ShaderDeviceAdapterInternal,
  selectNoColorPbrVariant,
  selectPipelineLayoutForVariant,
} from './material-shader-policy';
import type { MeshSsboGrowResult, MeshSsboState } from './mesh-ssbo-grow';
import { registerMotionBlurPostProcess } from './motion-blur-registration';
import {
  type GenerationAggregate,
  type GenerationPublication,
  publishGeneration,
} from './recovery/generation';
import { createRendererRecovery, type RendererRecovery } from './recovery/renderer-recover';
import {
  collectRequiredFullscreenPostProcesses,
  withBuiltinRenderFeatures,
} from './render-feature-post-processes';
import { createRenderTargetHost } from './render-target-host';
import {
  freezeRenderProfile,
  structuredRendererCause,
  validateRenderProfile,
} from './renderer-facade';
import { projectRendererFeatureInspection } from './renderer-feature-inspection';
import {
  type ContinuationTerminator,
  createContinuationTerminator,
  guardFrameCompletion,
} from './renderer-frame-transaction';
import {
  ensureContextConfigured,
  rendererInitializationError,
  rendererInitializationPipelineError,
  wrapDisposeError,
} from './renderer-helpers';
import { projectRendererOutputInspectionFromSurface } from './renderer-inspection';
import {
  createRecoveryContinuation,
  createRecoveryDeadline,
  createSingleFlight,
  type RecoveryPhase,
} from './renderer-lifecycle';
import { derivedPhysicsFrameError } from './webgpu-renderer-guards';
import {
  createRecoveryFailureLocation,
  type RecoveryFailureLocation,
} from './webgpu-renderer-recovery-failure';

export type { RecoveryFailureLocation } from './webgpu-renderer-recovery-failure';

import { STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES } from './shader-prewarm-policy';
import { buildReadyWebGPU } from './webgpu-ready';
import { DEPTH_TEXTURE_FORMAT, HDR_COLOR_ATTACHMENT_FORMAT } from './webgpu-ready-contract';
import { adaptMipmapShaderModuleFactory } from './webgpu-ready-mipmap';
import {
  tryCreateWebGPURenderer as tryCreateWebGPURendererBootstrap,
  type WebGPURendererInternals,
} from './webgpu-renderer-bootstrap';
import type { WebGPUOutcome } from './webgpu-renderer-contract';
import { projectReceiptColorObservations } from './webgpu-renderer-observation';
import {
  createRendererObservationCaptureOwner,
  type ObservationCaptureRead,
} from './webgpu-renderer-observation-owner';
import {
  isPreparedMaterialVertexLayout,
  PREPARED_INSTANCE_VERTEX_ATTRS,
  PREPARED_MATERIAL_INSTANCE_VERTEX_ATTRS,
  particleMaterialInputVertexBuffers,
  resolveWebGPUVertexBufferLayouts,
} from './webgpu-vertex-layouts';

export type { BundlerOptions } from './bundler-contract';
export { assembleMaterialProjection } from './material/assembly';
export type {
  LayoutKind,
  MaterialShaderBindingContract,
  MaterialShaderVertexInputContract,
} from './material-shader-policy';
export {
  allowsUnlitPreparedFallback,
  isSharedMaterialUserRegionCompatible,
  normalizeMaterialShaderVariantSet,
  requiresPreparedMaterialShader,
  resolveMaterialShaderBackendArtifactKey,
  resolveMaterialShaderBindingContract,
  resolveMaterialShaderUvSetCount,
  resolveMaterialShaderVariantSet,
  resolveMaterialShaderVertexInputContract,
  selectNoColorPbrVariant,
  selectPipelineLayoutForVariant,
  stripCloudShadowBindingsForLowLimit,
} from './material-shader-policy';
export {
  createMeshSsboGrowController,
  deriveStorageBufferCeiling,
  INITIAL_MESH_SSBO_SLOT_COUNT,
  type MeshSsboBufferWrapper,
  type MeshSsboGrowController,
  type MeshSsboGrowControllerInit,
  type MeshSsboGrowDevice,
  type MeshSsboGrowErrorRegistry,
  type MeshSsboGrowResult,
  type MeshSsboState,
  requireMeshSsboBuffer,
} from './mesh-ssbo-grow';
export { exposeRenderer } from './renderer-facade';
export {
  selectGpuDrivenSceneIndexVariant,
  selectHdrpPbrPrewarmVariants,
  selectProbePrewarmVariants,
  selectSkinPrewarmVariants,
  selectStandardPbrTransmissionPrewarmVariants,
} from './shader-prewarm-policy';
export type { WebGPUOutcome, WebGPURendererInternals } from './webgpu-renderer-contract';
export { disposeObservationCaptureSet } from './webgpu-renderer-observation';

/** Bundler injection and the WebGPU renderer construction entry points. */
export async function tryCreateWebGPURenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: RendererOptions | undefined,
  pack: RhiBackendPack,
  bundler: BundlerOptions | undefined,
): Promise<WebGPUOutcome> {
  return tryCreateWebGPURendererBootstrap(canvas, options, pack, bundler, makeWebGPURenderer);
}
async function makeWebGPURenderer(
  internals: WebGPURendererInternals,
): Promise<RendererAssemblyImplementation> {
  let disposed = false;
  const observeTiming = observeGpuPassTimingDisabled;
  const frameContinuations = new Set<ContinuationTerminator>();
  type RecoveryInspection = RenderInspection['recovery'];
  let recoveryAttempt = 0;
  let recoveryStaleLossEvents = 0;
  let recoveryInspection: RecoveryInspection = Object.freeze({
    phase: null,
    fromGeneration: 0,
    candidateGeneration: 0,
    attempt: 0,
    elapsedMs: 0,
    lastOutcome: 'none',
    rehydratedRoots: 0,
    staleLossEvents: 0,
  });
  const updateRecoveryInspection = (
    patch: Partial<RecoveryInspection>,
    clearFailureLocation = false,
  ): void => {
    const next = { ...recoveryInspection, ...patch, staleLossEvents: recoveryStaleLossEvents };
    if (clearFailureLocation) {
      delete next.failedOwner;
      delete next.failedResourceKind;
    }
    recoveryInspection = Object.freeze(next);
  };
  internals.generationState.onStaleLoss = () => {
    recoveryStaleLossEvents = Math.min(Number.MAX_SAFE_INTEGER, recoveryStaleLossEvents + 1);
    updateRecoveryInspection({});
  };
  let renderTargetDevice = internals.device;
  let renderTargetGeneration = 0;
  let renderSystemForTargetPromotion: RenderSystem | undefined;
  let cameraViewsForTargetPromotion:
    | { readonly active: boolean; isCubeCapturePending(target: RenderTarget): boolean }
    | undefined;
  const featureHostResult = createRenderFeatureHost(
    withBuiltinRenderFeatures(internals.options?.features ?? []),
  );
  if (!featureHostResult.ok) throw featureHostResult.error;
  internals.featureHost = featureHostResult.value;
  let rendererRecovery: RendererRecovery | undefined;
  const recoveryFlight = createSingleFlight<Result<void, RecoverFailure>>(async () => {
    if (disposed) return err(new RecoverError('recover-not-needed'));
    if (internals.healthRegistry.getLastSnapshot().reason !== 'device-lost') {
      return err(new RecoverError('recover-not-needed'));
    }
    const attempt = ++recoveryAttempt;
    const deadline = createRecoveryDeadline(Date.now());
    const fromGeneration = activeDeviceScope.generation;
    const candidateGeneration = fromGeneration + 1;
    let recoveryFailurePhase: RecoveryPhase = 'quiesce';
    updateRecoveryInspection(
      {
        phase: 'quiesce',
        fromGeneration,
        candidateGeneration,
        attempt,
        elapsedMs: 0,
        lastOutcome: 'none',
        rehydratedRoots: 0,
      },
      true,
    );
    const setRecoveryPhase = (phase: RecoveryPhase): void => {
      if (phase !== 'cleanup') recoveryFailurePhase = phase;
      updateRecoveryInspection({ phase, elapsedMs: deadline.elapsed(Date.now()) });
    };
    let candidateCleanup = (): void => undefined;
    const continuation = createRecoveryContinuation(deadline, () => candidateCleanup());
    const deadlineExpired = (phase: RecoveryPhase): boolean => {
      if (continuation.isValid(phase, Date.now())) return false;
      continuation.abandon(Date.now());
      continuation.cleanupOnce();
      return true;
    };
    let recoveryFailureLocation: RecoveryFailureLocation | undefined;
    let result: Result<void, RecoverFailure>;
    try {
      const recovery = rendererRecovery;
      if (recovery === undefined) {
        return err(new RecoverError('recover-device-unavailable'));
      }
      result = await recovery.recoverOnce(
        deadline,
        deadlineExpired,
        (cleanup) => {
          candidateCleanup = cleanup;
        },
        continuation,
        setRecoveryPhase,
        (count) => updateRecoveryInspection({ rehydratedRoots: count }),
        (failure) => {
          recoveryFailureLocation = failure;
        },
      );
    } catch (cause) {
      recoveryFailureLocation ??= createRecoveryFailureLocation('compile-graph', cause);
      candidateCleanup();
      result = err(new RecoverError('recover-device-unavailable'));
    }
    if (result.ok) {
      updateRecoveryInspection(
        {
          phase: null,
          fromGeneration,
          candidateGeneration: activeDeviceScope.generation,
          elapsedMs: deadline.elapsed(Date.now()),
          lastOutcome: 'succeeded',
        },
        true,
      );
      return result;
    }
    if (result.error.code === 'recover-not-needed' && !disposed) {
      updateRecoveryInspection(
        { phase: null, elapsedMs: deadline.elapsed(Date.now()), lastOutcome: 'none' },
        true,
      );
      return result;
    }
    const outcome = disposed ? 'disposed' : 'failed';
    const failureLocation = outcome === 'disposed' ? undefined : recoveryFailureLocation;
    const failurePhase =
      outcome === 'disposed' ? 'cleanup' : (failureLocation?.phase ?? recoveryFailurePhase);
    const isAcquisitionPhase = (phase: RecoveryPhase): boolean =>
      phase === 'acquire-adapter' || phase === 'acquire-device';
    const retryable =
      outcome === 'failed' && (failureLocation?.retryable ?? isAcquisitionPhase(failurePhase));
    const failure = createRecoveryFailedError({
      phase: failurePhase,
      oldGeneration: fromGeneration,
      candidateGeneration,
      attempt,
      elapsedMs: deadline.elapsed(Date.now()),
      retryable,
      guidance:
        outcome === 'disposed'
          ? 'rebuild-renderer'
          : (failureLocation?.guidance ?? (retryable ? 'retry' : 'repair-owner')),
      owner: outcome === 'disposed' ? 'renderer' : (failureLocation?.owner ?? 'renderer'),
      resourceKind:
        outcome === 'disposed' ? 'surface' : (failureLocation?.resourceKind ?? 'pipeline'),
      lastOutcome: outcome,
      rehydratedRoots: recoveryInspection.rehydratedRoots,
      staleLossEvents: recoveryStaleLossEvents,
      cause: outcome === 'disposed' ? result.error : (failureLocation?.cause ?? result.error),
      cleanupFailures: [],
      receipt: activeDeviceScope._receipt(),
    });
    updateRecoveryInspection(
      {
        phase: null,
        elapsedMs: failure.detail.elapsedMs,
        lastOutcome: outcome,
        rehydratedRoots: 0,
      },
      false,
    );
    return err(failure);
  });
  // Keep producer-declared shader identities live across the renderer
  // lifetime. Features can be installed after boot (the public late-install
  // seam used by asset-driven hosts), so a recovery rebuild must include their
  // modules in the same prewarm set as boot. A boot-only snapshot would let the
  // first recovered frame observe a cold async shader adapter and emit a
  // spurious prepared-pipeline failure before the next-frame retry succeeds.
  const requiredMaterialShaderSet = new Set(
    featureHostResult.value.features.flatMap((feature) => feature.requiredMaterialShaders ?? []),
  );
  let requiredMaterialShaders = Object.freeze([...requiredMaterialShaderSet]);
  let requiredFullscreenPostProcesses = Object.freeze(
    collectRequiredFullscreenPostProcesses(featureHostResult.value.features),
  );
  // Lazy ShaderCatalog instance (plan-strategy section S-10 / D-R10 / OQ-5
  // close): constructed on first access; subsequent accesses return the
  // same instance. Recovery owns a second, candidate-only state object while
  // the active state continues serving frames. The two states are swapped
  // only by the synchronous generation publication boundary below; no
  // recovery await can expose a partially rebuilt adapter or catalog.
  type RendererShaderState = {
    readonly device: RhiDevice;
    shaderInstance: ShaderCatalog | null;
    sharedShaderModuleAdapter: ShaderDeviceAdapterInternal | null;
    sharedImmediateShaderModuleAdapter: ShaderDeviceAdapterInternal | null;
  };
  let activeShaderState: RendererShaderState = {
    device: internals.device,
    shaderInstance: null,
    sharedShaderModuleAdapter: null,
    sharedImmediateShaderModuleAdapter: null,
  };
  let candidateShaderState: RendererShaderState | undefined;
  const getShaderModuleAdapter = (): ShaderDeviceAdapterInternal => {
    const state = candidateShaderState ?? activeShaderState;
    if (state.sharedShaderModuleAdapter === null) {
      state.sharedShaderModuleAdapter = makeShaderDeviceAdapter(
        state.device,
        internals.errorRegistry,
        internals.pack.createShaderModule,
        internals.pack.createShaderModuleImmediate,
      );
    }
    return state.sharedShaderModuleAdapter;
  };
  const getImmediateShaderModuleAdapter = (): ShaderDeviceAdapterInternal => {
    const state = candidateShaderState ?? activeShaderState;
    if (state.sharedImmediateShaderModuleAdapter === null) {
      state.sharedImmediateShaderModuleAdapter = makeShaderDeviceAdapter(
        state.device,
        internals.errorRegistry,
        internals.pack.createShaderModule,
        internals.pack.createShaderModuleImmediate,
        'immediate',
      );
    }
    return state.sharedImmediateShaderModuleAdapter;
  };
  const prewarmFullscreenFeatureModules = async (
    feature: RenderFeature<unknown>,
  ): Promise<Result<void, RhiError>> => {
    for (const postProcess of feature.requiredFullscreenPostProcesses ?? []) {
      const label = postProcessShaderModuleLabel(postProcess.source);
      const shaderResult = internals.pack.createShaderModule
        ? await internals.pack.createShaderModule(internals.device, {
            code: postProcess.source,
            label,
          })
        : await invokeDeviceCreateShaderModule(internals.device, {
            code: postProcess.source,
            label,
          });
      if (!shaderResult.ok) {
        internals.errorRegistry.fire(shaderResult.error);
        return err(shaderResult.error);
      }
      getShaderModuleAdapter().seedModule(label, shaderResult.value);
    }
    return ok(undefined);
  };
  const getShader = (): ShaderCatalog => {
    const state = candidateShaderState ?? activeShaderState;
    if (state.shaderInstance === null) {
      const activeCatalog = activeShaderState.shaderInstance;
      // Reuse validated manifest CPU rows; candidate preparation selects variants.
      // feat-20260608-create-app-param-surface-trim / M2 / D-2 q5-A:
      // shaderManifestUrl moved to BundlerOptions (third arg). The fallback
      // literal '/shaders/manifest.json' stays here so the LO 1.1
      // hello-window zero-config takeoff path keeps working without an
      // bundler injection. The 'shaderManifestUrl' in (...) check preserves
      // the zero-entry opt-in: explicitly passing
      // `bundler: { shaderManifestUrl: undefined }` retains the
      // old "no manifest fetched" mode used by tests / camera-only worlds.
      state.shaderInstance =
        state === candidateShaderState && activeCatalog !== null
          ? activeCatalog.forkForDevice(getShaderModuleAdapter())
          : new ShaderCatalog({
              device: getShaderModuleAdapter(),
              manifestUrl:
                internals.bundler !== undefined && 'shaderManifestUrl' in internals.bundler
                  ? internals.bundler.shaderManifestUrl
                  : '/shaders/manifest.json',
            });
    }
    return state.shaderInstance;
  };
  const shaderCatalog = getShader();
  const assets = new AssetRegistry(
    shaderCatalog,
    internals.importTransport,
    [audioLoader],
    postSpawnResolveJoints,
  );
  // feat-20260601-device/gpu-residency-extraction M1: the GPU residency layer
  // lives in a standalone store; `assets` keeps the CPU POD registry only.
  let gpuStore = new GpuResidencyCache();
  let activeDeviceScope = DeviceScope.create(0, 'renderer');
  // feat-20260623-world-space-video-asset M4 / w16 (D-3): transient per-frame
  // video texture store, fully independent of gpuStore (AC-08). Configured with
  // the device alongside gpuStore below; threaded into the record stage via the
  // RenderSystemRuntime so a `videoTextureFields` material field uploads its
  // frame here instead of entering the static ensureResident cache.
  let dynamicTextureStore = new DynamicTextureStore();
  const renderTargetHost = createRenderTargetHost({
    onError: (error) => internals.errorRegistry.fire(error),
    rendererId: Symbol('renderer'),
    getGeneration: () => renderTargetGeneration,
    getDevice: () => renderTargetDevice,
    canPromoteTarget: (target: RenderTarget) =>
      (cameraViewsForTargetPromotion?.active
        ? cameraViewsForTargetPromotion.isCubeCapturePending(target)
        : renderSystemForTargetPromotion?.isCubeCapturePending(target)) !== true,
  });
  const publicationReceiver =
    internals.options?.publicationSource === undefined
      ? undefined
      : new RenderPublicationReceiver(internals.options.publicationSource, renderTargetHost);
  // feat-20260527-sprite-nineslice M4 / w16 (D-5): detached host-owned
  // EngineMetrics counter reaches the record stage via `RenderSystemRuntime.metrics`.
  // (`nineslice.scale-too-small`, `nineslice.tile-needs-repeat-sampler`) bump
  // counters through the owning service (charter P3 machine-readable signals
  // over a per-frame console.warn flood). Each renderer assembly owns its own
  // counter Map (D-5 candidate 1 isolation); Renderer does not expose it.
  const metrics = createEngineMetrics();
  let extendedLightingState = createExtendedLightingState(activeDeviceScope.generation);
  const gpuPassTimingOptions = internals.options?.gpuPassTiming;
  const timingRetentionFrames =
    gpuPassTimingOptions?.retentionFrames !== undefined &&
    Number.isInteger(gpuPassTimingOptions.retentionFrames) &&
    gpuPassTimingOptions.retentionFrames >= 1 &&
    gpuPassTimingOptions.retentionFrames <= 8
      ? gpuPassTimingOptions.retentionFrames
      : DEFAULT_GPU_PASS_TIMING_OPTIONS.retentionFrames;
  let gpuPassTimingSession: GpuPassTimingSession | undefined;
  let gpuPassTimingUnavailable: GpuPassTimingObservation | undefined;
  const timingObservationStore =
    gpuPassTimingOptions === undefined
      ? undefined
      : createGpuPassTimingObservationStore({
          retentionFrames: timingRetentionFrames,
          currentDeviceGeneration: () => activeDeviceScope.generation,
        });
  const retireGpuPassTimingSession = (): void => {
    const retired = gpuPassTimingSession;
    gpuPassTimingSession = undefined;
    retired?.dispose();
  };
  const failedGpuPassTimingObservation = (error: GpuPassTimingReason): GpuPassTimingObservation => {
    const latestKnownGood = timingObservationStore?.inspect().latestKnownGood;
    return {
      status: 'failed',
      error,
      ...(latestKnownGood === undefined ? {} : { latestKnownGood }),
    };
  };
  const establishGpuPassTimingSession = (): void => {
    retireGpuPassTimingSession();
    gpuPassTimingUnavailable = undefined;
    if (gpuPassTimingOptions === undefined) return;
    const created = createGpuPassTimingSession(internals.device, gpuPassTimingOptions);
    if (created.ok) {
      gpuPassTimingSession = created.value;
      return;
    }
    gpuPassTimingUnavailable = {
      status: 'unavailable',
      reason: created.error,
      capability: {
        timestampQuery: internals.device.caps.timestampQuery,
        timestampPeriodNanoseconds: internals.device.caps.timestampPeriodNanoseconds,
      },
    };
  };
  establishGpuPassTimingSession();
  // feat-20260629 M4: per-material-shader UV set count from naga vertex
  // @location reflection. Populated during prepareMaterialShaders from
  // MaterialShaderManifestEntry.uvSetCount. Read by getMaterialShaderPipeline
  // to auto-fill shaderUvSetCount for clamp-to-last alias.
  let materialShaderUvSetCounts = new Map<string, number>();
  // feat-20260527-sprite-nineslice M4 / w18 prep (D-9): hand the same
  // EngineMetrics instance to AssetRegistry so register-time soft-warns
  // (sliceMode=1 + sampler.addressMode !== 'repeat') bump
  // 'nineslice.tile-needs-repeat-sampler' on the SAME counter the runtime
  // reads.
  assets.setMetrics(metrics);
  // feat-20260707 M5 / w33 (D-11 + D-8): project the RhiCaps three-way
  // compression triple into the codec-facing `TranscodeCaps` and wire it into
  // the registry so the texture / equirect Basis arms can pick a transcode
  // target. One-line projection; the loader stays a pure consumer of declared ctx input (Pipeline Isolation).
  assets.setTranscodeCaps({
    bc: internals.device.caps.textureCompressionBc,
    etc2: internals.device.caps.textureCompressionEtc2,
    astc: internals.device.caps.textureCompressionAstc,
  });
  // M1 (bug-20260601-hello-tonemap-material-register D-1/D-2): prepare
  // engine-shipped material shaders (cap gate + manifest load + registration)
  // so they are available in ShaderCatalog before `register<MaterialAsset>`.
  // Failures throw structured RhiError / ShaderError through `createRenderer`.
  await prepareMaterialShaders(internals.device, getShader, assets, materialShaderUvSetCounts);
  // MaterialAsset per-slot texCoord: the built-in standard PBR + skin shaders
  // unconditionally declare all eight supported UV sets so they can honor
  // per-slot coordinate selection. Their vertex layout must therefore always
  // carry the declared UV slots or CreateRenderPipeline rejects the module.
  // in VertexState"). `materialShaderUvSetCounts` is the SSOT both PSO paths read
  // (buildPipelineContext + getMaterialShaderPipeline) to drive the clamp-to-last
  // alias; naga reflection can be stale for engine-shipped modules, so the
  // count is asserted explicitly. Missing mesh sets are clamp-to-last aliases.
  materialShaderUvSetCounts.set('forgeax::default-standard-pbr', 8);
  materialShaderUvSetCounts.set(SKIN_MATERIAL_SHADER_ID, 8);
  const packShaderFactory = adaptMipmapShaderModuleFactory(internals.pack.createShaderModule);
  // The RhiDevice surface satisfies `MipmapBlitDevice` (createTexture +
  // createTextureView + createCommandEncoder + createBindGroup +
  // queue.submit + queue.writeTexture all live on RhiDevice).
  // feat-20260601-device/gpu-residency-extraction M1 (D-3 / D-8): device +
  // shader-module factory + cube-POD register relay are wired onto the store
  // together. feat-20260614 M8 (D-15 / D-17): `registerCube` is the wire-layer
  // closure `(world, pod) => world.allocSharedRef('EquirectAsset', pod)` --
  // the runtime-minted cube POD lands in the draw-time world's user-tier
  // SharedRefStore (the AssetRegistry owns no handles). feat-20260630 M2 / w11:
  // the retired cube-texture asset kind is gone; the relay mints an EquirectAsset
  // shared ref as the cubemap GPU residency's identity token.
  gpuStore.configureGpuDevice(
    internals.device,
    packShaderFactory,
    (world, pod, source) => {
      // The accepted equirect identity already owns this renderer-local GPU projection.
      if ('resolveAsset' in world) return ok(source);
      const handle = world.allocSharedRef('EquirectAsset', pod);
      return ok(handle);
    },
    internals.device.caps,
  );
  gpuStore.configureIblDevice(
    internals.device,
    internals.pack.createShaderModule === undefined
      ? undefined
      : (
          (createShaderModule) => (device, descriptor) =>
            createShaderModule(device, descriptor)
        )(internals.pack.createShaderModule),
  );
  gpuStore.bindDeviceScope(activeDeviceScope);
  // feat-20260623-world-space-video-asset M4 / w16 (D-3): wire the same device
  // into the transient video texture store (createTexture / createTextureView /
  // destroyTexture / queue.copyExternalImageToTexture all live on RhiDevice).
  dynamicTextureStore.configureGpuDevice(adaptDynamicTextureDevice(internals.device));
  // D-S3: Renderer.initialization three-step strict-serial Promise. Kicked off
  // synchronously here so `await renderer.initialization` is the AI-user-facing
  // barrier; failure is structured and goes through Promise reject (no
  // throw, no silent skip — charter proposition 4 explicit failure).
  let pipelineState: PipelineState | null = null;
  type RendererGeneration = GenerationAggregate<
    RhiDevice,
    RhiCanvasContext,
    PipelineState,
    RendererGenerationBindings,
    undefined
  >;
  const generationPublication: GenerationPublication<RendererGeneration | undefined> = {
    current: undefined,
  };
  const publishRendererGeneration = (candidate: RendererGeneration): void => {
    publishGeneration(generationPublication, candidate, (value) => value.scope.isAlive());
    activeDeviceScope = candidate.scope;
    dynamicGeometry.invalidateGeneration(activeDeviceScope.generation);
    internals.generationState.current = activeDeviceScope.generation;
    pipelineState = candidate.pipeline;
    const bindings = candidate.producerBindings;
    gpuStore = bindings.gpuStore;
    dynamicTextureStore = bindings.dynamicTextureStore;
    activeShaderState = bindings.shaderState;
    activePipelineCacheState = bindings.pipelineCacheState;
    materialShaderUvSetCounts = bindings.materialShaderUvSetCounts;
    emptyPostProcessBgl = bindings.emptyPostProcessBgl;
    if (bindings.growMeshSsbo === undefined) delete internals.growMeshSsbo;
    else internals.growMeshSsbo = bindings.growMeshSsbo;
    if (bindings.meshSsboState === undefined) delete internals.meshSsboState;
    else internals.meshSsboState = bindings.meshSsboState;
    gpuStore.bindDeviceScope(activeDeviceScope);
  };
  let readySettled = false;
  const materialShaderPipelineCache = new Map<string, RenderPipeline>();
  const materialShaderPipelineGroup2Contracts = new WeakMap<object, PipelineGroup2Contract>();
  const materialShaderManifestEntryCache = new Map<string, MaterialShaderManifestEntry>();
  // Variant resolution only depends on the requested axes, device capability
  // axes, and the manifest entry that owns the declarations. Cache it by the
  // manifest's variants-array identity so hot replacement naturally gets a
  // fresh result without adding a global strong reference to shader metadata.
  const materialShaderVariantResolutionCache = new WeakMap<
    object,
    Map<string, string | undefined>
  >();
  const group0MaterialLayout: {
    materialBgl: BindGroupLayout;
    pipelineLayout: PipelineLayout;
  } | null = null;
  const viewOnlyMaterialPipelineLayout: PipelineLayout | null = null;
  const viewAndSceneDepthMaterialPipelineLayout: PipelineLayout | null = null;
  const group0ResourceLayouts = new Map<
    string,
    { materialBgl: BindGroupLayout; pipelineLayout: PipelineLayout }
  >();
  const preparedMaterialPipelineLayoutCache = new Map<string, PipelineLayout>();
  // Cache authored material layouts by their exact mesh and lighting contract.
  type PerShaderMaterialLayout = {
    materialBgl: BindGroupLayout;
    pipelineLayout: PipelineLayout;
  };
  type PerShaderMaterialLayoutCacheEntry = {
    readonly source: string;
    readonly paramSchema: readonly ParamSchemaEntry[];
    readonly layoutKind: LayoutKind;
    readonly layout: PerShaderMaterialLayout | null;
  };
  const perShaderMaterialLayoutCache = new Map<string, PerShaderMaterialLayoutCacheEntry>();
  // Material binding contracts are derived from WGSL source, but the lookup
  // is also used by the per-submesh bind-group path. Cache the derived value
  // per renderer so a frame does not re-run the comment stripping and regex
  // scan for every visible submesh. Keep the source alongside the result so
  // shader hot-replacement invalidates the entry naturally.
  const materialShaderBindingContractCache = new Map<
    string,
    { source: string; contract: MaterialShaderBindingContract }
  >();
  type RendererPipelineCacheState = {
    materialShaderPipelineCache: typeof materialShaderPipelineCache;
    materialShaderManifestEntryCache: typeof materialShaderManifestEntryCache;
    materialShaderVariantResolutionCache: typeof materialShaderVariantResolutionCache;
    group0MaterialLayout: {
      materialBgl: BindGroupLayout;
      pipelineLayout: PipelineLayout;
    } | null;
    viewOnlyMaterialPipelineLayout: PipelineLayout | null;
    viewAndSceneDepthMaterialPipelineLayout: PipelineLayout | null;
    group0ResourceLayouts: typeof group0ResourceLayouts;
    preparedMaterialPipelineLayoutCache: typeof preparedMaterialPipelineLayoutCache;
    perShaderMaterialLayoutCache: typeof perShaderMaterialLayoutCache;
    materialShaderBindingContractCache: typeof materialShaderBindingContractCache;
  };
  const createRendererPipelineCacheState = (): RendererPipelineCacheState => ({
    materialShaderPipelineCache: new Map(),
    materialShaderManifestEntryCache: new Map(),
    materialShaderVariantResolutionCache: new WeakMap(),
    group0MaterialLayout: null,
    viewOnlyMaterialPipelineLayout: null,
    viewAndSceneDepthMaterialPipelineLayout: null,
    group0ResourceLayouts: new Map(),
    preparedMaterialPipelineLayoutCache: new Map(),
    perShaderMaterialLayoutCache: new Map(),
    materialShaderBindingContractCache: new Map(),
  });
  let activePipelineCacheState: RendererPipelineCacheState = {
    materialShaderPipelineCache,
    materialShaderManifestEntryCache,
    materialShaderVariantResolutionCache,
    group0MaterialLayout,
    viewOnlyMaterialPipelineLayout,
    viewAndSceneDepthMaterialPipelineLayout,
    group0ResourceLayouts,
    preparedMaterialPipelineLayoutCache,
    perShaderMaterialLayoutCache,
    materialShaderBindingContractCache,
  };
  let candidatePipelineCacheState: RendererPipelineCacheState | undefined;
  let candidateMaterialShaderUvSetCounts: Map<string, number> | undefined;
  let emptyPostProcessBgl: BindGroupLayout | null = null;
  let candidateEmptyPostProcessBgl: BindGroupLayout | null | undefined;
  type RendererCandidateState = {
    readonly device: RhiDevice;
    readonly context: RhiCanvasContext;
    readonly scope: DeviceScope;
    readonly gpuStore: GpuResidencyCache;
    readonly dynamicTextureStore: DynamicTextureStore;
    readonly shaderState: RendererShaderState;
    readonly pipelineCacheState: RendererPipelineCacheState;
    readonly materialShaderUvSetCounts: Map<string, number>;
    pipelineState: PipelineState | null;
    emptyPostProcessBgl: BindGroupLayout | null;
    growMeshSsbo: ((neededSlots: number) => MeshSsboGrowResult) | undefined;
    meshSsboState: MeshSsboState | undefined;
  };
  type RendererGenerationBindings = {
    readonly gpuStore: GpuResidencyCache;
    readonly dynamicTextureStore: DynamicTextureStore;
    readonly shaderState: RendererShaderState;
    readonly pipelineCacheState: RendererPipelineCacheState;
    readonly materialShaderUvSetCounts: Map<string, number>;
    readonly emptyPostProcessBgl: BindGroupLayout | null;
    readonly growMeshSsbo: ((neededSlots: number) => MeshSsboGrowResult) | undefined;
    readonly meshSsboState: MeshSsboState | undefined;
  };
  let candidateBuildState: RendererCandidateState | undefined;
  const currentPipelineCacheState = (): RendererPipelineCacheState =>
    candidatePipelineCacheState ?? activePipelineCacheState;
  const currentPipelineState = (): PipelineState | null =>
    candidateBuildState === undefined ? pipelineState : candidateBuildState.pipelineState;
  const currentBuildDevice = (): RhiDevice => candidateBuildState?.device ?? internals.device;
  const currentMaterialShaderUvSetCounts = (): Map<string, number> =>
    candidateMaterialShaderUvSetCounts ?? materialShaderUvSetCounts;
  const currentEmptyPostProcessBgl = (): BindGroupLayout | null =>
    candidateEmptyPostProcessBgl === undefined ? emptyPostProcessBgl : candidateEmptyPostProcessBgl;
  const getCachedMaterialShaderBindingContract = (
    materialShaderId: string,
  ): MaterialShaderBindingContract => {
    const cacheState = currentPipelineCacheState();
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    if (!lookup.ok) return 'render-material';
    const cached = cacheState.materialShaderBindingContractCache.get(materialShaderId);
    if (cached?.source === lookup.value.source) return cached.contract;
    const contract = resolveMaterialShaderBindingContract(lookup.value.source);
    cacheState.materialShaderBindingContractCache.set(materialShaderId, {
      source: lookup.value.source,
      contract,
    });
    return contract;
  };
  const getOrBuildGroup0MaterialLayout = (): {
    materialBgl: BindGroupLayout;
    pipelineLayout: PipelineLayout;
  } | null => {
    const cacheState = currentPipelineCacheState();
    if (cacheState.group0MaterialLayout !== null) return cacheState.group0MaterialLayout;
    if (currentPipelineState() === null) return null;
    const bglRes = currentBuildDevice().createBindGroupLayout({ entries: [] });
    if (!bglRes.ok) {
      internals.errorRegistry.fire(bglRes.error);
      return null;
    }
    const plRes = currentBuildDevice().createPipelineLayout({
      label: 'material-group-0-pipeline-layout',
      bindGroupLayouts: [bglRes.value],
    });
    if (!plRes.ok) {
      internals.errorRegistry.fire(plRes.error);
      return null;
    }
    cacheState.group0MaterialLayout = { materialBgl: bglRes.value, pipelineLayout: plRes.value };
    return cacheState.group0MaterialLayout;
  };
  const getOrBuildViewOnlyMaterialPipelineLayout = (): PipelineLayout | null => {
    const cacheState = currentPipelineCacheState();
    if (cacheState.viewOnlyMaterialPipelineLayout !== null) {
      return cacheState.viewOnlyMaterialPipelineLayout;
    }
    const currentState = currentPipelineState();
    if (currentState === null) return null;
    const plRes = currentBuildDevice().createPipelineLayout({
      label: 'material-view-only-pipeline-layout',
      bindGroupLayouts: [currentState.viewBindGroupLayout],
    });
    if (!plRes.ok) {
      internals.errorRegistry.fire(plRes.error);
      return null;
    }
    cacheState.viewOnlyMaterialPipelineLayout = plRes.value;
    return cacheState.viewOnlyMaterialPipelineLayout;
  };
  const getOrBuildViewAndSceneDepthMaterialPipelineLayout = (): PipelineLayout | null => {
    const cacheState = currentPipelineCacheState();
    if (cacheState.viewAndSceneDepthMaterialPipelineLayout !== null) {
      return cacheState.viewAndSceneDepthMaterialPipelineLayout;
    }
    const bglRes = currentBuildDevice().createBindGroupLayout({
      label: 'material-view-scene-depth-bgl',
      entries: [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'depth', viewDimension: '2d', multisampled: false },
        },
      ],
    });
    if (!bglRes.ok) {
      internals.errorRegistry.fire(bglRes.error);
      return null;
    }
    const plRes = currentBuildDevice().createPipelineLayout({
      label: 'material-view-scene-depth-pipeline-layout',
      bindGroupLayouts: [bglRes.value],
    });
    if (!plRes.ok) {
      internals.errorRegistry.fire(plRes.error);
      return null;
    }
    cacheState.viewAndSceneDepthMaterialPipelineLayout = plRes.value;
    return cacheState.viewAndSceneDepthMaterialPipelineLayout;
  };
  const getOrBuildGroup0ResourceLayout = (
    materialShaderId: string,
  ): { materialBgl: BindGroupLayout; pipelineLayout: PipelineLayout } | null => {
    const cacheState = currentPipelineCacheState();
    const cached = cacheState.group0ResourceLayouts.get(materialShaderId);
    if (cached !== undefined) return cached;
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    if (
      !lookup.ok ||
      !/@group\s*\(\s*0\s*\)\s*@binding\s*\(\s*0\s*\)[^;]*texture_depth_2d/u.test(
        lookup.value.source,
      )
    ) {
      return null;
    }
    const bgl = currentBuildDevice().createBindGroupLayout({
      label: `material-group-0-resource-${materialShaderId}`,
      entries: [
        {
          binding: 0,
          visibility: 2,
          texture: { sampleType: 'depth', viewDimension: '2d', multisampled: false },
        },
      ],
    });
    if (!bgl.ok) return null;
    const pipelineLayout = currentBuildDevice().createPipelineLayout({
      label: `material-group-0-resource-pl-${materialShaderId}`,
      bindGroupLayouts: [bgl.value],
    });
    if (!pipelineLayout.ok) return null;
    const built = { materialBgl: bgl.value, pipelineLayout: pipelineLayout.value };
    cacheState.group0ResourceLayouts.set(materialShaderId, built);
    return built;
  };
  const getOrBuildPreparedMaterialPipelineLayout = (
    materialShaderId: string,
    clustered = false,
  ): PipelineLayout | null => {
    const cacheState = currentPipelineCacheState();
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    const source = lookup.ok ? lookup.value.source : '';
    const hasView =
      /@group\s*\(\s*0\s*\)\s*@binding\s*\(\s*0\s*\)\s*var\s*<\s*uniform\s*>\s*view(?:X_naga_oil_mod_[A-Z0-9]+)?\b/u.test(
        source,
      );
    const hasSceneDepthAtZero =
      /@group\s*\(\s*0\s*\)\s*@binding\s*\(\s*0\s*\)[^;]*texture_depth_2d\b/u.test(source);
    const hasSceneDepthAtOne =
      /@group\s*\(\s*0\s*\)\s*@binding\s*\(\s*1\s*\)[^;]*texture_depth_2d\b/u.test(source);
    const sceneInputKind =
      hasSceneDepthAtOne && hasView ? 'view-depth' : hasSceneDepthAtZero ? 'depth' : 'view';
    const cacheKey = `${materialShaderId}:${clustered ? 'cluster' : 'mesh'}:${sceneInputKind}`;
    const cached = cacheState.preparedMaterialPipelineLayoutCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const currentState = currentPipelineState();
    if (currentState === null) return null;
    const materialBgl =
      (isEngineOwnedMaterialShader(materialShaderId)
        ? undefined
        : getOrBuildPerShaderMaterialLayout(materialShaderId)?.materialBgl) ??
      currentState.materialBindGroupLayout;
    let sceneInputLayout: BindGroupLayout = currentState.viewBindGroupLayout;
    if (sceneInputKind !== 'view') {
      const sceneInputLayoutResult = currentBuildDevice().createBindGroupLayout({
        label: `prepared-material-${sceneInputKind}-${materialShaderId}`,
        entries:
          sceneInputKind === 'view-depth'
            ? [
                {
                  binding: 0,
                  visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
                  buffer: { type: 'uniform' as const },
                },
                {
                  binding: 1,
                  visibility: GPU_SHADER_STAGE_FRAGMENT,
                  texture: {
                    sampleType: 'depth' as const,
                    viewDimension: '2d' as const,
                    multisampled: false,
                  },
                },
              ]
            : [
                {
                  binding: 0,
                  visibility: GPU_SHADER_STAGE_FRAGMENT,
                  texture: {
                    sampleType: 'depth' as const,
                    viewDimension: '2d' as const,
                    multisampled: false,
                  },
                },
              ],
      });
      if (!sceneInputLayoutResult.ok) {
        internals.errorRegistry.fire(sceneInputLayoutResult.error);
        return null;
      }
      sceneInputLayout = sceneInputLayoutResult.value;
    }
    const usesMaterialGroup = clustered || /@group\s*\(\s*1\s*\)/u.test(source);
    const lightingLayout = clustered
      ? currentBuildDevice().createBindGroupLayout({
          label: `prepared-material-lighting-${materialShaderId}`,
          entries: createHdrpBindGroupLayoutDescriptor().entries.filter(
            (entry) => entry.binding >= 3,
          ),
        })
      : undefined;
    if (lightingLayout !== undefined && !lightingLayout.ok) {
      internals.errorRegistry.fire(lightingLayout.error);
      return null;
    }
    const result = currentBuildDevice().createPipelineLayout({
      label: `prepared-material-pl-${materialShaderId}`,
      bindGroupLayouts: [
        sceneInputLayout,
        ...(usesMaterialGroup ? [materialBgl] : []),
        ...(lightingLayout?.ok ? [lightingLayout.value] : []),
      ],
    });
    if (!result.ok) {
      internals.errorRegistry.fire(result.error);
      return null;
    }
    cacheState.preparedMaterialPipelineLayoutCache.set(cacheKey, result.value);
    return result.value;
  };
  const getOrBuildPerShaderMaterialLayout = (
    materialShaderId: string,
    explicitParamSchema?: readonly ParamSchemaEntry[],
    layoutKind: LayoutKind = 'pbr',
    clustered = false,
  ): PerShaderMaterialLayout | null => {
    const cacheState = currentPipelineCacheState();
    const currentState = currentPipelineState();
    if (currentState === null) return null;
    if (isEngineOwnedMaterialShader(materialShaderId) && !clustered) return null;
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    const source = lookup.ok ? lookup.value.source : '';
    const paramSchema = lookup.ok ? lookup.value.paramSchema : explicitParamSchema;
    const singleLayerMedium =
      materialShaderId === 'forgeax::single-layer-medium' ||
      (lookup.ok && lookup.value.receipt?.surface?.model === 'single-layer-medium');
    if (paramSchema === undefined) return null;
    const cacheKey = `${materialShaderId}:${layoutKind}:${clustered}`;
    const cached = cacheState.perShaderMaterialLayoutCache.get(cacheKey);
    if (
      cached?.source === source &&
      cached.paramSchema === paramSchema &&
      cached.layoutKind === layoutKind
    ) {
      return cached.layout;
    }
    // A custom schema may reuse the shared PBR layout only when every derived
    // binding is an identical canonical prefix. Otherwise build its own layout
    // so texture dimensions and sampler/storage shapes cannot drift.
    const requiresStandardMapLayout =
      isCanonicalStandardPbrMaterialShader(materialShaderId) ||
      isStandardPbrMaterialShader(materialShaderId) ||
      standardPhysicalTextureFields(paramSchema).length > 0;
    const isStandardMapLayout = requiresStandardMapLayout;
    if (
      !clustered &&
      !singleLayerMedium &&
      !isStandardMapLayout &&
      isSharedMaterialUserRegionCompatible(paramSchema)
    ) {
      cacheState.perShaderMaterialLayoutCache.set(cacheKey, {
        source,
        paramSchema,
        layoutKind,
        layout: null,
      });
      return null;
    }
    const spec: PipelineSpec = {
      shader: {
        id: singleLayerMedium ? 'forgeax::single-layer-medium' : materialShaderId,
        passKind: 'forward',
        variantSet: undefined,
      },
      attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
      geometry: { topology: 'triangle-list', vertexLayout: {} },
      renderState: undefined,
    };
    const desc = buildBindGroupLayoutDescriptor(spec, {
      kind: 'pbr-material-merged',
      materialParamSchema: paramSchema,
      caps: {
        storageBuffer: currentBuildDevice().caps.storageBuffer,
        transmissionBackdrop: transmissionBackdropAvailable(
          currentBuildDevice().limits.maxSampledTexturesPerShaderStage,
        ),
      },
    });
    const bglRes = currentBuildDevice().createBindGroupLayout(desc);
    if (!bglRes.ok) {
      internals.errorRegistry.fire(bglRes.error);
      return null;
    }
    const bindGroups = resolveMaterialPipelineBindGroups(
      layoutKind,
      currentState,
      clustered,
      getShader().materialProgram(source).probeBlendRecordRequired,
    );
    if (bindGroups === null) return null;
    const plRes = currentBuildDevice().createPipelineLayout({
      label: `pbr-pl-${materialShaderId}`,
      bindGroupLayouts: [
        currentState.viewBindGroupLayout,
        bglRes.value,
        bindGroups.meshLayout,
        bindGroups.instancesLayout,
      ],
    });
    if (!plRes.ok) {
      internals.errorRegistry.fire(plRes.error);
      return null;
    }
    const built = { materialBgl: bglRes.value, pipelineLayout: plRes.value };
    cacheState.perShaderMaterialLayoutCache.set(cacheKey, {
      source,
      paramSchema,
      layoutKind,
      layout: built,
    });
    return built;
  };
  const resolveCachedMaterialShaderVariantSet = (
    requestedVariantSet: string | undefined,
    manifestEntry: import('@forgeax/engine-shader').MaterialShaderManifestEntry | undefined,
  ): string | undefined => {
    // Keep lazy PSO resolution aligned with buildReadyWebGPU's sampled-texture gate.
    const device = currentBuildDevice();
    const sampledTextureLimit = device.limits.maxSampledTexturesPerShaderStage;
    if (manifestEntry === undefined) {
      return resolveMaterialShaderVariantSet(
        requestedVariantSet,
        [],
        device.caps.backendKind,
        device.caps.storageBuffer,
        sampledTextureLimit,
      );
    }
    const variants = manifestEntry.variants;
    let byRequest = materialShaderVariantResolutionCache.get(variants);
    if (byRequest === undefined) {
      byRequest = new Map();
      materialShaderVariantResolutionCache.set(variants, byRequest);
    }
    const cacheKey = `${requestedVariantSet ?? '\u0000'}|${device.caps.backendKind}|${device.caps.storageBuffer ? '1' : '0'}|${sampledTextureLimit ?? '\u0000'}`;
    if (byRequest.has(cacheKey)) return byRequest.get(cacheKey);
    const resolved = resolveMaterialShaderVariantSet(
      requestedVariantSet,
      variants,
      device.caps.backendKind,
      device.caps.storageBuffer,
      sampledTextureLimit,
    );
    byRequest.set(cacheKey, resolved);
    return resolved;
  };
  const findMaterialShaderManifestEntry = (
    materialShaderId: string,
  ): MaterialShaderManifestEntry | undefined => {
    const cacheState = currentPipelineCacheState();
    const cached = cacheState.materialShaderManifestEntryCache.get(materialShaderId);
    if (cached !== undefined) return cached;
    for (const candidate of getShader().materialShaderManifestEntries()) {
      if (candidate.identifier === materialShaderId) {
        cacheState.materialShaderManifestEntryCache.set(materialShaderId, candidate);
        return candidate;
      }
    }
    return undefined;
  };
  const promotePipelineExtendedLighting = (state: PipelineState, scope: DeviceScope): void => {
    if (
      state.extendedLightingAvailable !== true ||
      state.iesProfileTexture === undefined ||
      state.cookieTexture === undefined ||
      state.cookieMatrixBuffer === undefined ||
      state.iesProfileTextureView === undefined ||
      state.cookieTextureView === undefined ||
      state.ltcLambertTextureView === undefined ||
      state.ltcGgxTextureView === undefined
    ) {
      return;
    }
    const candidate: ExtendedLightingResourceCandidate = {
      topology: EXTENDED_LIGHTING_TOPOLOGY,
      generation: scope.generation,
      scope,
      iesSliceCount: 0,
      cookieSliceCount: 0,
      cookieMatrices: 0,
      sampler: state.defaultSampler,
      iesTexture: state.iesProfileTexture,
      cookieTexture: state.cookieTexture,
      cookieMatrixBuffer: state.cookieMatrixBuffer,
      descriptorBytes:
        IES_SLICE_WIDTH * IES_SLICE_HEIGHT * 2 * 32 +
        COOKIE_SLICE_MIP_CHAIN_BYTES * 32 +
        COOKIE_MATRIX_BYTES,
      uploadCount: 5,
    };
    extendedLightingState = promoteExtendedLightingCandidate(extendedLightingState, candidate);
  };
  let tonemapRegistered = false,
    fxaaRegistered = false;
  let temporalPostProcessesRegistered = false,
    depthOfFieldRegistered = false;
  const buildPipeline = (
    scope: DeviceScope = activeDeviceScope,
    device: RhiDevice = currentBuildDevice(),
    residencyStore: GpuResidencyCache = gpuStore,
  ): Promise<PipelineState> =>
    buildReadyWebGPU(
      device,
      scope,
      getShader,
      residencyStore,
      internals.pack.createShaderModule,
      internals.errorRegistry,
      candidateBuildState === undefined
        ? requiredMaterialShaders
        : [
            ...new Set([...requiredMaterialShaders, ...getShader().materialShaderIdentifiers()]),
          ].filter(
            // Material publication installs all cooked alternatives, including
            // optional outputs the active device never compiled. Recover only
            // successfully used modules plus explicitly required feature inputs.
            (id) =>
              requiredMaterialShaders.includes(id) ||
              (!isEngineOwnedMaterialShader(id) &&
                (activeShaderState.sharedShaderModuleAdapter?.hasModule(`module-${id}`) === true ||
                  activeShaderState.sharedImmediateShaderModuleAdapter?.hasModule(
                    `module-${id}`,
                  ) === true)),
          ),
      materialShaderUvSetCounts.get('forgeax::default-standard-pbr') ?? 0,
      requiredFullscreenPostProcesses,
      (hook, state) => {
        if (candidateBuildState !== undefined) {
          candidateBuildState.growMeshSsbo = hook;
          candidateBuildState.meshSsboState = state;
        } else {
          internals.growMeshSsbo = hook;
          internals.meshSsboState = state;
        }
      },
      (label, module) => {
        getShaderModuleAdapter().seedModule(label, module);
        getImmediateShaderModuleAdapter().seedModule(label, module);
      },
      (key, pso, group2Contract) => {
        const pipelineCache = currentPipelineCacheState().materialShaderPipelineCache;
        if (!pipelineCache.has(key)) {
          pipelineCache.set(key, pso);
        }
        materialShaderPipelineGroup2Contracts.set(pso as object, group2Contract);
      },
      (source: string) => {
        if (candidateBuildState !== undefined || tonemapRegistered) return;
        renderSystem.registerBuiltinPostProcess(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, {
          source,
          params: { byteSize: 16, defaultValue: new Uint8Array(16) },
          reads: ['hdrColor'],
        });
        tonemapRegistered = true;
      },
      (source: string) => {
        fxaaRegistered = registerFxaaPostProcess(renderSystem, source, fxaaRegistered);
      },
      (source: string) =>
        registerAnalyticFogPostProcess(renderSystem, source, candidateBuildState !== undefined),
      (entries: { readonly motionBlur?: string; readonly taaResolve?: string }) => {
        if (candidateBuildState !== undefined || temporalPostProcessesRegistered) return;
        if (entries.motionBlur !== undefined) {
          registerMotionBlurPostProcess(renderSystem, entries.motionBlur);
        }
        if (entries.taaResolve !== undefined) {
          renderSystem.registerBuiltinPostProcess('forgeax.taa-resolve', {
            source: entries.taaResolve,
            params: { byteSize: 16, defaultValue: new Uint8Array(16) },
            reads: ['scene-color', 'scene-temporal', 'taa-history-color', 'taa-history-temporal'],
          });
        }
        temporalPostProcessesRegistered = true;
      },
      (entries: { readonly singleSample?: string; readonly multisampled?: string }) => {
        if (candidateBuildState !== undefined || depthOfFieldRegistered) return;
        registerDepthOfFieldBuiltins(renderSystem, entries);
        depthOfFieldRegistered = true;
      },
      (sources: VolumetricFogShaderSources) => {
        internals.volumetricFogShaders = sources;
      },
      (sources: SsrShaderSources, pyramid: DepthPyramidShaderSources) => {
        internals.ssrShaders = sources;
        internals.depthPyramidShaders = pyramid;
      },
      (sources: AtmosphereShaderSources) => {
        internals.atmosphereShaders = sources;
      },
      (sources) => {
        internals.standardDeferredShaders = sources;
      },
    ).then(async (state) => {
      // draw() is synchronous. Complete the opt-in capability probe before
      // publishing readiness, including when rebuilding a lost device.
      await renderSystem.initializeSsr(device);
      return state;
    });
  const ready: Promise<Result<void, RhiError>> = buildPipeline().then(
    (state): Result<void, RhiError> => {
      pipelineState = state;
      promotePipelineExtendedLighting(state, activeDeviceScope);
      readySettled = true;
      return ok(undefined);
    },
    (e: unknown): Result<void, RhiError> => {
      readySettled = true;
      if (e instanceof RhiError) return err(e);
      if (e instanceof PipelineSpecError) return err(rendererInitializationPipelineError(e));
      return err(rendererInitializationError(e));
    },
  );
  /**
   * bug-20260527-renderstate-pipeline-dispatch-gap D-3:
   * finds the engine-shipped PBR manifest entry from the shader registry
   * by content marker (f_schlick BRDF helper call, same marker
   * buildReadyWebGPU uses). Returns undefined when the manifest is
   * empty (Camera-only path) or the pbr entry is not found.
   */
  const findStandardPbrEntry = (
    variantSet?: string,
  ): import('@forgeax/engine-types').ManifestEntry | undefined => {
    const device = currentBuildDevice();
    let standardEntry: import('@forgeax/engine-types').ManifestEntry | undefined;
    for (const entry of getShader().entries()) {
      if (entry.wgsl.includes('f_schlick')) {
        standardEntry = entry;
        break;
      }
    }
    if (standardEntry === undefined) return undefined;
    const pbrManifestEntry = [...getShader().materialShaderManifestEntries()].find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    const noColorVariant = selectNoColorPbrVariant(
      pbrManifestEntry,
      device.caps.storageBuffer,
      variantSet,
      deriveExtendedLightingCapability(device).admitted,
      device.caps.backendKind === 'webgpu' || device.caps.backendKind === 'wgpu-native',
      (device.limits.maxSampledTexturesPerShaderStage ?? 0) >=
        STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
    );
    if (noColorVariant !== undefined && noColorVariant.composedWgsl !== standardEntry.wgsl) {
      return { ...standardEntry, wgsl: noColorVariant.composedWgsl };
    }
    const runtimePbr = getShader().findMaterialArtifact('forgeax::default-standard-pbr');
    if (runtimePbr.ok && runtimePbr.value.source !== standardEntry.wgsl) {
      return { ...standardEntry, wgsl: runtimePbr.value.source };
    }
    return standardEntry;
  };
  const buildPipelineContext = (
    variantSet?: string,
    materialShaderId?: string,
    group2Contract: PipelineGroup2Contract = 'mesh',
    // Skin layouts derive their vertex ABI from the shared attribute projection.
    meshAttributes?: VertexAttributeMap,
    vertexLayout?: string,
    vertexLayoutProjection?: VertexLayoutProjection,
    shaderModuleMode?: RenderFeatureShaderModuleMode,
    layoutKindOverride?: LayoutKind,
    particleInputLanes?: number,
  ) => {
    const contractLayoutKind: LayoutKind =
      group2Contract === 'cluster'
        ? 'hdrp-pbr'
        : group2Contract === 'skin-cluster'
          ? 'hdrp-skin'
          : group2Contract === 'skin'
            ? 'pbr-skin'
            : 'pbr';
    const layoutKind = layoutKindOverride ?? contractLayoutKind;
    const gpuClustered =
      (layoutKind === 'gpu-driven-pbr' || layoutKind === 'gpu-driven-skin') &&
      (group2Contract === 'cluster' || group2Contract === 'skin-cluster');
    const usesSharedBootMaterialLayout =
      !gpuClustered &&
      materialShaderId !== undefined &&
      isEngineOwnedMaterialShader(materialShaderId);
    // Built-in layouts are assembled at boot; authored layouts must not bypass
    // the HDRP group(2) selector or bind the URP mesh BGL to a cluster PSO.
    const perShaderLayout =
      !usesSharedBootMaterialLayout && materialShaderId !== undefined
        ? getOrBuildPerShaderMaterialLayout(materialShaderId, undefined, layoutKind, gpuClustered)
        : null;
    // Authored shaders retain their own material schema and selected mesh
    // layout, including skin. Built-in IDs keep their boot-time layout.
    const bindingContract =
      materialShaderId === undefined
        ? 'render-material'
        : getCachedMaterialShaderBindingContract(materialShaderId);
    const group0Layout = bindingContract === 'group-0' ? getOrBuildGroup0MaterialLayout() : null;
    const group0ResourceLayout =
      bindingContract === 'group-0-resource' && materialShaderId !== undefined
        ? getOrBuildGroup0ResourceLayout(materialShaderId)
        : null;
    const viewOnlyLayout =
      bindingContract === 'view-only' ? getOrBuildViewOnlyMaterialPipelineLayout() : null;
    const viewAndSceneDepthLayout =
      bindingContract === 'view-and-scene-depth'
        ? getOrBuildViewAndSceneDepthMaterialPipelineLayout()
        : null;
    const preparedMaterialLayout =
      (bindingContract === 'render-material' ||
        bindingContract === 'render-material-with-scene-depth' ||
        bindingContract === 'render-material-and-scene-depth') &&
      materialShaderId !== undefined &&
      isPreparedMaterialVertexLayout(vertexLayout)
        ? getOrBuildPreparedMaterialPipelineLayout(materialShaderId, group2Contract === 'cluster')
        : null;
    const materialShaderLookup =
      materialShaderId === undefined
        ? undefined
        : getShader().findMaterialArtifact(materialShaderId);
    const materialShaderSource = materialShaderLookup?.ok
      ? materialShaderLookup.value.source
      : undefined;
    const vertexInputContract =
      materialShaderId === undefined
        ? 'render-material'
        : materialShaderSource !== undefined
          ? resolveMaterialShaderVertexInputContract(materialShaderSource)
          : 'render-material';
    const currentState = currentPipelineState();
    const pipelineLayout =
      group0Layout !== null
        ? group0Layout.pipelineLayout
        : group0ResourceLayout !== null
          ? group0ResourceLayout.pipelineLayout
          : viewOnlyLayout !== null
            ? viewOnlyLayout
            : viewAndSceneDepthLayout !== null
              ? viewAndSceneDepthLayout
              : preparedMaterialLayout !== null
                ? preparedMaterialLayout
                : perShaderLayout !== null
                  ? perShaderLayout.pipelineLayout
                  : selectPipelineLayoutForVariant(currentState, variantSet, layoutKind);
    if (pipelineLayout === null) return null;
    const currentMaterialUvSetCounts = currentMaterialShaderUvSetCounts();
    const resolvedUvSetCount =
      materialShaderId !== undefined
        ? (currentMaterialUvSetCounts.get(materialShaderId) ??
          (materialShaderSource !== undefined
            ? resolveMaterialShaderUvSetCount(
                materialShaderSource,
                currentMaterialUvSetCounts.get(materialShaderId),
              )
            : undefined))
        : undefined;
    const vertexBuffers = resolveWebGPUVertexBufferLayouts({
      vertexInputContract,
      vertexLayout,
      vertexLayoutProjection,
      resolvedUvSetCount,
      layoutKind,
      meshAttributes,
      particleInputLanes,
    });
    return {
      device: currentBuildDevice(),
      shaderModuleFactory:
        shaderModuleMode === 'immediate'
          ? getImmediateShaderModuleAdapter()
          : getShaderModuleAdapter(),
      pipelineLayout,
      vertexBuffers,
      ...(layoutKind === 'pbr-skin' ||
      layoutKind === 'gpu-driven-skin' ||
      layoutKind === 'gpu-driven-cluster-skin'
        ? { layoutKind }
        : {}),
    };
  };
  /**
   * Builds a pipeline for the given entry, caches it keyed by cacheKey,
   * and returns it. Returns null on build failure (firing errorRegistry
   * for non-transient errors).
   */
  const buildAndCachePipeline = (
    cacheKey: string,
    entry: MaterialShaderEntry,
    label: string,
    moduleLabel: string,
    isHdr: boolean,
    renderState: MaterialRenderState | undefined,
    topology: PrimitiveTopology | undefined,
    stripIndexFormat: 'uint16' | 'uint32' | undefined,
    // feat-20260609 M4.5 / w37 (D-10): thread variantSet to the layout selector
    // so HDRP-variant PSOs build with `hdrpPbrPipelineLayout` (7-slot group(2))
    // and URP-variant PSOs build with `pbrPipelineLayout` (1-slot group(2)).
    variantSet?: string,
    passKind: PassKind = 'forward',
    // bug-20260611-skin-pipeline-layout: thread materialShaderId so
    // buildPipelineContext can derive `LayoutKind === 'pbr-skin'` and pick
    // the 2-entry mesh-array BGL chain.
    materialShaderId?: string,
    // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
    // pass the per-mesh `VertexAttributeMap` so the pbr-skin path's
    // vertex buffer layout flows from the SSOT `deriveVertexBufferLayout`
    // (vertex-attribute-layout.ts) instead of a parallel hardcoded copy.
    // Undefined falls into the synthetic 6-key sentinel inside
    // `buildPipelineContext` (key-presence-only); non-skin layoutKinds
    // ignore this parameter entirely.
    meshAttributes?: VertexAttributeMap,
    // bug-20260615 M2 / m2-1: sampleCount drives the multisample descriptor
    // field in buildPipelineForMaterialShader — it is a CAMERA fact (per-frame
    // antialias setting), not a material renderState value. Default 1 preserves
    // byte-identity of every existing pre-M2 cache slot + descriptor.
    sampleCount: number = 1,
    // feat-20260625-refactor-sprite-as-transparent-mesh R2 fix-up: LDR-color
    // override for sub-passes that write to a non-default attachment view.
    // Pre-feat the dedicated `forgeax::default-sprite` SPEC_CONST entries
    // (SPRITE_ATTACHMENTS_LDR_S1/S4) targeted the swap-chain STORAGE format
    // (non-sRGB) directly. Post-w14 sprite falls into the generic lazy build
    // path which defaults to `pipelineState.colorAttachmentFormat` (the sRGB
    // VIEW format used by the geometry pass) — incompatible with the sprite
    // sub-pass's non-sRGB attachment view (bgra8unorm / rgba8unorm), firing
    // a per-frame "Attachment state ... not compatible" validation error.
    // The sprite sub-pass call site passes `pipelineState.format` (storage,
    // non-sRGB) here so the resulting PSO matches the encoder's attachment
    // state. Undefined preserves the default (sRGB view) path used by every
    // pre-fix-up caller. Ignored when `isHdr=true` or `passKind='shadow-caster'`.
    colorFormatOverride?: GPUTextureFormat,
    // Prepared graphics passes use `null` to request an explicit color-only
    // pipeline; omitted preserves the material forward depth default.
    depthFormatOverride?: GPUTextureFormat | null,
    vertexLayout?: string,
    vertexLayoutProjection?: VertexLayoutProjection,
    shaderModuleMode?: RenderFeatureShaderModuleMode,
    layoutKindOverride?: LayoutKind,
    vertexEntryPoint?: string,
    additionalColorFormats?: readonly GPUTextureFormat[],
    vertexEntry?: string,
    authoredFragmentEntry?: string,
    particleInputLanes?: number,
    coverageOnly = false,
    constants?: Readonly<Record<string, number>>,
  ): RenderPipeline | null => {
    const declaredGroup2Contract = resolveMaterialPipelineGroup2Contract(
      getShader().materialProgram(entry.source).group2,
      layoutKindOverride,
    );
    const group2Contract =
      declaredGroup2Contract === 'mesh' &&
      (materialShaderId === 'forgeax::vfx-render.particles.mesh' ||
        materialShaderId === 'forgeax::vfx-render.particles.mesh-inputs') &&
      (variantSet === '' || variantSet?.includes('CLUSTER_FORWARD_AVAILABLE=true') === true)
        ? 'cluster'
        : declaredGroup2Contract;
    const resolvedVertexEntry = resolveMaterialPipelineVertexEntry(
      layoutKindOverride,
      vertexEntryPoint,
      vertexEntry,
    );
    const ctx = buildPipelineContext(
      variantSet,
      materialShaderId,
      group2Contract,
      meshAttributes,
      vertexLayout,
      vertexLayoutProjection,
      shaderModuleMode,
      layoutKindOverride,
      particleInputLanes,
    );
    if (ctx === null) return null;
    const currentState = currentPipelineState();
    if (currentState === null) return null;
    const ldrColorFormat = colorFormatOverride ?? currentState.colorAttachmentFormat;
    const fragmentEntry: string | undefined =
      authoredFragmentEntry ??
      (isHdr &&
      passKind === 'forward' &&
      (materialShaderId === 'forgeax::sprite' || materialShaderId === 'forgeax::sprite-lit')
        ? 'fs_main_hdr'
        : undefined);
    // Public view clipping is dynamic coverage even on opaque casters.
    // Preserve the producer's fragment stage so depth and color agree.
    const built = buildPipelineForMaterialShader(
      cacheKey,
      // The catalog entry is projected into the material-shader entry shape.
      entry,
      {
        ...ctx,
        colorFormat: isHdr ? HDR_COLOR_ATTACHMENT_FORMAT : ldrColorFormat,
        colorFormats:
          additionalColorFormats === undefined
            ? undefined
            : [
                renderState?.outputs?.[0]?.format ??
                  (isHdr ? HDR_COLOR_ATTACHMENT_FORMAT : ldrColorFormat),
                ...additionalColorFormats,
              ],
        depthFormat:
          depthFormatOverride === null
            ? undefined
            : passKindPolicyTable[passKind]?.shape === 'depth-only'
              ? (depthFormatOverride ?? 'depth32float')
              : (depthFormatOverride ?? DEPTH_TEXTURE_FORMAT),
        coverageOnly,
        ...(constants === undefined ? {} : { constants }),
        label,
        // feat-20260604 w16-b: the shader-MODULE cache identity. Stable across
        // per variant. See PipelineBuilderContext.moduleLabel.
        moduleLabel,
      },
      renderState,
      // w8/w15: pack topology (+ stripIndexFormat) into the builder's geometry
      // param. Strip topologies bake stripIndexFormat into the immutable PSO
      // (WebGPU spec: only valid for line-strip / triangle-strip). The record
      // stage (w9 + w15) threads each mesh's topology + indexFormat here; when
      // the caller omits stripIndexFormat we fall back to 'uint32' (the engine
      // procedural index width: createBoxGeometry etc. emit Uint32 indices).
      topology !== undefined
        ? {
            topology,
            ...(topology === 'line-strip' || topology === 'triangle-strip'
              ? { stripIndexFormat: stripIndexFormat ?? ('uint32' as const) }
              : {}),
          }
        : undefined,
      resolvedVertexEntry,
      fragmentEntry,
      undefined, // defines — none
      passKind,
      sampleCount,
    );
    if (!built.ok) {
      if (built.error.code !== 'rhi-not-available') {
        internals.errorRegistry.fire(built.error);
      }
      return null;
    }
    currentPipelineCacheState().materialShaderPipelineCache.set(cacheKey, built.value);
    materialShaderPipelineGroup2Contracts.set(built.value as object, group2Contract);
    return built.value;
  };
  const getMaterialShaderPipeline = (
    materialShaderId: string,
    isHdr: boolean,
    renderState?: MaterialRenderState,
    topology?: PrimitiveTopology,
    indexFormat?: 'uint16' | 'uint32',
    variantSet?: string,
    passKind: PassKind = 'forward',
    meshAttributes?: VertexAttributeMap,
    // bug-20260615 M2 / m2-1: sampleCount is threaded through to the cache key,
    // buildAndCachePipeline, and ultimately buildPipelineForMaterialShader which
    // sets the multisample descriptor field. Default 1 preserves byte-identity
    // of every pre-M2 caller.
    sampleCount: number = 1,
    // feat-20260625-refactor-sprite-as-transparent-mesh R2 fix-up: LDR-color
    // override for sub-passes that write to a non-default attachment view.
    // The LDR sprite split sub-pass writes through the storage (non-sRGB)
    // view of the swap-chain texture; the encoder's beginRenderPass
    // colorFormats uses `pipelineState.format` (storage), so the PSO must
    // build with the same non-sRGB format or WebGPU rejects SetPipeline
    // with "Attachment state ... not compatible". Pre-w14 the dedicated
    // `forgeax::default-sprite` SPEC_CONST entries (deleted) baked this
    // mapping into SPRITE_ATTACHMENTS_LDR_S1/S4; the generic lazy build
    // path that replaced them defaults to `colorAttachmentFormat` (the
    // sRGB view used by the geometry pass), so transparent-split callers
    // must override. Threaded into both the cache key (via the spec's
    // `attachments.colorFormats`) and the actual PSO descriptor. Ignored
    // for `isHdr=true` (HDR sub-pass uses rgba16float) and
    // `passKind='shadow-caster'` (depth-only, no color attachment).
    colorFormatOverride?: GPUTextureFormat,
    // feat-20260629-multi-uv-set-support m3-w5: shader-declared UV set count,
    // forwarded to PipelineSpec.geometry.shaderUvSetCount for clamp-to-last
    // alias. Undefined = fallback to mesh-provided count (no clamping).
    // m4-w3: auto-filled from naga reflection when caller passes undefined.
    shaderUvSetCount?: number,
    // Prepared graphics passes use `null` to request an explicit color-only
    // pipeline; omitted preserves the material forward depth default.
    depthFormatOverride?: GPUTextureFormat | null,
    vertexLayout?: string,
    vertexLayoutProjection?: VertexLayoutProjection,
    shaderModuleMode: RenderFeatureShaderModuleMode = 'validated',
    layoutKindOverride?: LayoutKind,
    vertexEntryPoint?: string,
    additionalColorFormats?: readonly GPUTextureFormat[],
    vertexEntry?: string,
    fragmentEntry?: string,
    particleInputLanes?: number,
    constants?: Readonly<Record<string, number>>,
  ): RenderPipeline | null => {
    const coverageOnly =
      passKind === 'temporal' && variantSet?.split('+').includes('COVERAGE_ONLY=true') === true;
    // WebGL2 is a downlevel backend even when the record stage asks for the
    // native-capability variant string. Resolve the variant axes at this
    // shared PSO seam so the shader source, BGL layout, and cache key agree on
    // the actual device capabilities. Without this, WebGL2 can build a
    // storage-buffer PSO around a uniform-buffer shader and only reject it at
    // queue submit as an invalid RenderPipeline.
    const currentState = currentPipelineState();
    const ldrColorFormat: GPUTextureFormat =
      colorFormatOverride ??
      (currentState !== null ? currentState.colorAttachmentFormat : 'bgra8unorm-srgb');
    // feat-20260629 M4: auto-fill shaderUvSetCount from naga reflection
    // (stored in materialShaderUvSetCounts during prepareMaterialShaders).
    const materialShaderIdForPass = resolveMaterialPipelineShaderId(materialShaderId, passKind);
    const pipelineShaderId = resolveMaterialShaderBackendArtifactKey(
      materialShaderIdForPass,
      internals.device.caps.backendKind,
      assets.getMaterialArtifact(materialShaderIdForPass),
    );
    const materialShaderLookup = getShader().findMaterialArtifact(pipelineShaderId);
    const materialShaderSource = materialShaderLookup.ok
      ? materialShaderLookup.value.source
      : undefined;
    const currentMaterialUvSetCounts = currentMaterialShaderUvSetCounts();
    const materialUvSetCount = resolveMaterialShaderUvSetCount(
      materialShaderSource,
      currentMaterialUvSetCounts.get(pipelineShaderId),
    );
    if (materialUvSetCount !== undefined) {
      currentMaterialUvSetCounts.set(pipelineShaderId, materialUvSetCount);
    }
    const resolvedUvSetCount = shaderUvSetCount ?? materialUvSetCount;
    const manifestEntry = findMaterialShaderManifestEntry(pipelineShaderId);
    // Sprite's omitted request is the boot-selected default artifact. The
    // explicit empty key remains the PER_INSTANCE_REGION=true request used by
    // SpriteInstances, so only that path is capability-rewritten here.
    const resolvedVariantSet =
      variantSet === undefined &&
      (pipelineShaderId === 'forgeax::sprite' || pipelineShaderId === 'forgeax::sprite-lit')
        ? undefined
        : resolveCachedMaterialShaderVariantSet(variantSet, manifestEntry);
    // The record stage composes capability axes; plain custom shaders retain
    // only manifest-declared axes so '' cannot select an HDRP mesh layout.
    // Builtin forgeax:: shaders keep the compatibility request
    // when a reduced test/legacy manifest omits variant metadata.
    // A single-source manifest entry must stay on its canonical module key;
    // otherwise a synthesized capability axis races the prewarmed module.
    let effectiveVariantSet = normalizeMaterialShaderVariantSet(resolvedVariantSet, manifestEntry);
    // A published artifact is already backend-specific; no manifest means no synthesized key.
    if (manifestEntry === undefined) effectiveVariantSet = undefined;
    if (
      vertexLayoutProjection === undefined &&
      manifestEntry?.variants.some((variant) => 'VERTEX_COLOR_AVAILABLE' in variant.defines)
    ) {
      if (effectiveVariantSet === '') {
        const noColorVariant = manifestEntry.variants.find(
          (variant) =>
            variant.defines.VERTEX_COLOR_AVAILABLE === false &&
            Object.entries(variant.defines).every(
              ([axis, value]) => axis === 'VERTEX_COLOR_AVAILABLE' || value === true,
            ),
        );
        effectiveVariantSet = noColorVariant?.definesKey ?? 'VERTEX_COLOR_AVAILABLE=false';
      } else {
        effectiveVariantSet = effectiveVariantSet?.replace(
          'VERTEX_COLOR_AVAILABLE=true',
          'VERTEX_COLOR_AVAILABLE=false',
        );
      }
    }
    if (
      manifestEntry !== undefined &&
      !pipelineShaderId.startsWith('forgeax::') &&
      effectiveVariantSet !== undefined &&
      effectiveVariantSet !== ''
    ) {
      const declaredAxes = new Set<string>();
      for (const variant of manifestEntry.variants) {
        for (const axis of Object.keys(variant.defines)) declaredAxes.add(axis);
      }
      const filteredVariantParts = effectiveVariantSet
        .split('+')
        .filter((part) => declaredAxes.has(part.slice(0, part.indexOf('='))))
        .sort();
      effectiveVariantSet =
        filteredVariantParts.length === 0 ? undefined : filteredVariantParts.join('+');
    }
    const colorFormat: GPUTextureFormat =
      renderState?.outputs?.[0]?.format ?? (isHdr ? 'rgba16float' : ldrColorFormat);
    additionalColorFormats ??= renderState?.outputs?.slice(1).map((output) => output.format);
    const isDepthOnlyPass = passKindPolicyTable[passKind]?.shape === 'depth-only';
    const resolvedVertexEntry = vertexEntry ?? vertexEntryPoint;
    const inputVertexBuffers = particleMaterialInputVertexBuffers(vertexLayout, particleInputLanes);
    const spec: PipelineSpec = {
      shader: {
        id: pipelineShaderId,
        passKind,
        variantSet: effectiveVariantSet,
        ...(resolvedVertexEntry === undefined ? {} : { vertexEntry: resolvedVertexEntry }),
        ...(fragmentEntry === undefined ? {} : { fragmentEntry }),
        ...(constants === undefined ? {} : { constants }),
      },
      attachments: {
        colorFormats:
          additionalColorFormats === undefined
            ? colorFormatsForPassKind(passKind, colorFormat)
            : [colorFormat, ...additionalColorFormats],
        depthFormat: isDepthOnlyPass
          ? (depthFormatOverride ?? 'depth32float')
          : depthFormatOverride === null
            ? undefined
            : (depthFormatOverride ?? 'depth32float-stencil8'),
        sampleCount: (sampleCount === 4 ? 4 : 1) as 1 | 4,
      },
      geometry: {
        topology: topology ?? 'triangle-list',
        stripIndexFormat: indexFormat,
        vertexLayout:
          meshAttributes ??
          (vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.positionSizeColorInstance
            ? PREPARED_INSTANCE_VERTEX_ATTRS
            : isPreparedMaterialVertexLayout(vertexLayout)
              ? PREPARED_MATERIAL_INSTANCE_VERTEX_ATTRS
              : DEFAULT_VERTEX_ATTRIBUTE_MAP),
        // Thread the shader-declared count whenever it is greater than one.
        // Built-in PBR reserves all eight supported UV inputs; single-UV meshes
        // remain byte-stable because missing sets are clamp-to-last aliases.
        ...(resolvedUvSetCount !== undefined && resolvedUvSetCount > 1
          ? { shaderUvSetCount: resolvedUvSetCount }
          : {}),
        ...(vertexLayoutProjection === undefined ? {} : { vertexLayoutProjection }),
        ...(inputVertexBuffers === undefined ? {} : { vertexBuffers: inputVertexBuffers }),
      },
      renderState,
    };
    const cacheKey = `${cacheKeyOf(spec)}|vertex:${resolvedVertexEntry ?? 'vs_main'}`;
    const cached = currentPipelineCacheState().materialShaderPipelineCache.get(cacheKey);
    if (cached !== undefined) return cached;
    if (pipelineState === null) return null;
    const lookup = getShader().findMaterialArtifact(pipelineShaderId);
    if (!lookup.ok) {
      if (requiresPreparedMaterialShader(vertexLayout)) {
        // Only a registered shader can be warming up. Preserve a permanent
        // lookup failure instead of turning it into an endless pending PSO.
        throw lookup.error;
      }
      // bug-20260527-renderstate-pipeline-dispatch-gap D-3:
      // fallback path parity -- when renderState is defined and the
      // shader id is not registered, build a renderState-variant of
      // the standard pipeline from the engine-shipped PBR entry.
      if (
        renderState === undefined &&
        !allowsUnlitPreparedFallback(depthFormatOverride, vertexLayout, pipelineShaderId)
      ) {
        // A prepared feature declares the vertex layout it owns. Falling back
        // to default-unlit here would pair that data with the unlit shader's
        // position/normal/uv/tangent inputs and let WebGPU reject the
        // pipeline at validation time. Keep the missing shader retryable and
        // preserve the declared input contract instead.
        return null;
      }
      if (renderState === undefined) {
        const unlitLookup = getShader().findMaterialArtifact('forgeax::default-unlit');
        if (!unlitLookup.ok) return null;
        return buildAndCachePipeline(
          cacheKey,
          unlitLookup.value,
          `pbr-pipeline-prepared-${pipelineShaderId}`,
          // Reuse the eagerly compiled engine unlit module. The adapter cache
          // is seeded under this label during renderer readiness; a new label
          // would keep color-only prepared passes in perpetual warm-up.
          'unlit',
          isHdr,
          undefined,
          topology,
          indexFormat,
          effectiveVariantSet,
          passKind,
          'forgeax::default-unlit',
          meshAttributes,
          sampleCount,
          colorFormatOverride,
          depthFormatOverride,
          vertexLayout,
          vertexLayoutProjection,
          shaderModuleMode,
          layoutKindOverride,
          vertexEntryPoint,
          additionalColorFormats,
          undefined,
          undefined,
          undefined,
          coverageOnly,
          constants,
        );
      }
      const pbrEntry = findStandardPbrEntry(effectiveVariantSet);
      if (pbrEntry === undefined) return null;
      return buildAndCachePipeline(
        cacheKey,
        { source: pbrEntry.wgsl, paramSchema: [] },
        `pbr-pipeline-fallback-${pipelineShaderId}${isHdr ? '-hdr' : ''}`,
        // w16-b: module identity is the fallback PBR source, stable across
        // topology / renderState / HDR (all baked into the PSO) so every
        // variant reuses one compiled module.
        'module-fallback-pbr',
        isHdr,
        renderState,
        topology,
        indexFormat,
        // M4.5 / w37 (D-10): the fallback path also threads variantSet so the
        // layout selector picks HDRP layout when an HDRP caller falls into
        // this branch (registered shader id missing).
        effectiveVariantSet,
        // feat-20260609 / T-002: passKind threaded through the fallback path
        // for parity with the main path; default 'forward' keeps every prior
        // fallback caller byte-identical.
        passKind,
        // bug-20260611-skin-pipeline-layout: passing materialShaderId here is
        // intentional even on the fallback (registered-id-missing) branch --
        // a missing skin shader registration should not silently pick the
        // wrong BGL chain. With LayoutKind='pbr-skin' the selector returns
        // null when pbrSkinPipelineLayout is null (charter P3 explicit fail).
        //
        // MaterialAsset per-slot texCoord: this branch always compiles the
        // built-in PBR module (`pbrEntry.wgsl` / 'module-fallback-pbr'), whose
        // vertex stage declares all eight UV inputs. The vertex-buffer layout
        // therefore has to be the PBR layout with all declared slots present,
        // not the caller shader's -- e.g. a transparent sprite / sprite-lit
        // material lands here with meshAttributes carrying only uv0, so the
        // sprite id would resolve a 48-byte 4-attribute layout and the PBR
        // module would reject a missing UV slot. Pass the built-in PBR id for
        // layout resolution so buildPipelineContext derives the layout that
        // matches the compiled module. Skin keeps its
        // own id so the pbr-skin fail-fast (null layout) is preserved.
        pipelineShaderId === SKIN_MATERIAL_SHADER_ID
          ? pipelineShaderId
          : 'forgeax::default-standard-pbr',
        // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
        // forward meshAttributes through the fallback path so the pbr-skin
        // layout chain reads from the deriveVertexBufferLayout SSOT here too.
        meshAttributes,
        sampleCount,
        colorFormatOverride,
        depthFormatOverride,
        vertexLayout,
        vertexLayoutProjection,
        shaderModuleMode,
        layoutKindOverride,
        vertexEntryPoint,
        additionalColorFormats,
        undefined,
        undefined,
        undefined,
        coverageOnly,
        constants,
      );
    }
    // feat-20260609 M4 / w31: resolve variant WGSL from manifest when
    // variantSet is non-empty. The boot-time registered shader (from
    // `installMaterialArtifact` at line ~2473) carries the default (all-true)
    // variant's WGSL. For URP callers that want a different variant
    // (e.g. STORAGE_BUFFER_AVAILABLE=true without CLUSTER_FORWARD_AVAILABLE),
    // we look up the manifest entry, find the matching variant, and
    // substitute its composedWgsl into the PSO build path. The pipeline
    // layout itself is built by buildPbrPipelineLayouts (M3 / w12).
    // When variantSet is empty/undefined, the boot-time registered entry
    // (which is the all-true default) is used verbatim — backward compat.
    let shaderEntry = lookup.value;
    // M4.5 / w38 (D-11): `variantSet === ''` is canonical all-true (HDRP
    // path) and MUST hit the manifest variant lookup -- treat it as a
    // first-class variant request, not a falsy "no variant" signal.
    // Use `!== undefined` so the empty-string case enters the lookup.
    if (effectiveVariantSet !== undefined) {
      const registry = getShader();
      for (const msEntry of registry.materialShaderManifestEntries()) {
        if (msEntry.identifier === pipelineShaderId) {
          const variant = findVariantByKey(msEntry, effectiveVariantSet);
          if (variant) {
            // M3 / w12-w13: variant substitution carries the same source +
            // paramSchema as the boot-registered entry; the binding layout
            // is no longer carried on MaterialShaderEntry (deleted in
            // w13) — buildPbrPipelineLayouts is the BGL SSOT and reads
            // derive(paramSchema).bglEntries on demand.
            shaderEntry = {
              source: variant.composedWgsl,
              program: registry.materialProgram(variant.composedWgsl),
              paramSchema: lookup.value.paramSchema,
              paramSchemaProjection: lookup.value.paramSchemaProjection,
            };
          }
          break;
        }
      }
    }
    shaderEntry = prepareLowLimitMaterialShaderEntry(
      shaderEntry,
      currentBuildDevice().limits.maxSampledTexturesPerShaderStage,
    );
    shaderEntry = { ...shaderEntry, program: getShader().materialProgram(shaderEntry.source) };
    // feat-20260609 M4 / R3-fixup: append `-${passKind}` to the PSO label so
    // GPU debug captures (and the shadow-caster branch in the builder)
    // make the cache variant visible. The fallback path above keeps the
    // pre-existing fallback-* label shape (no shadow-caster fallback
    // exists today; the only shadow caller registers shadowCaster directly).
    const passKindLabelSegment = passKind === 'forward' ? '' : `-${passKind}`;
    return buildAndCachePipeline(
      cacheKey,
      shaderEntry,
      `pbr-pipeline-${pipelineShaderId}${isHdr ? '-hdr' : ''}${passKindLabelSegment}`,
      // feat-20260609 M4 / w31: when variantSet is non-empty, the module identity
      // includes the variant key so URP (STORAGE_BUFFER_AVAILABLE=true) and HDRP
      // (CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true) variants
      // compile as separate shader modules (they have different WGSL sources).
      // When variantSet is empty/undefined, the module identity stays pre-M4
      // backward-compatible for all PSOs of the default variant.
      // M4.5 / w38 (D-11): same `!== undefined` discipline as the cache
      // key -- `''` (canonical all-true) gets its own module-label slot,
      // distinct from the no-variant path. Trailing `#` for the empty
      // case is intentional (parallel to the cache key's `:variant:`
      // empty-tail segment); module identity stays a function of the
      // exact variantSet string.
      effectiveVariantSet !== undefined
        ? `module-${pipelineShaderId}#${effectiveVariantSet}`
        : `module-${pipelineShaderId}`,
      isHdr,
      renderState,
      topology,
      indexFormat,
      // M4.5 / w37 (D-10): main path threads variantSet so HDRP-variant PSO
      // builds against `hdrpPbrPipelineLayout` (7-slot group(2) BGL) and URP
      // builds against `pbrPipelineLayout` (1-slot group(2) BGL).
      effectiveVariantSet,
      // feat-20260609 / T-002: passKind selects createRenderPipeline
      // attachment shape (forward color+DS vs shadow-caster depth32float
      // no-color). Orthogonal to variantSet (which selects the BGL chain).
      passKind,
      // bug-20260611-skin-pipeline-layout: thread the registered materialShaderId
      // so buildPipelineContext can resolve LayoutKind='pbr-skin' for the skin
      // shader (2-entry mesh-array BGL).
      pipelineShaderId,
      // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
      // forward meshAttributes so the pbr-skin path's vertex buffer layout
      // is derived via the SSOT (deriveVertexBufferLayout). For URP/HDRP
      // callers (and for a caller passing undefined) the synthetic 6-key
      // sentinel inside buildPipelineContext keeps the layout deterministic.
      meshAttributes,
      sampleCount,
      colorFormatOverride,
      depthFormatOverride,
      vertexLayout,
      vertexLayoutProjection,
      shaderModuleMode,
      layoutKindOverride,
      vertexEntryPoint,
      additionalColorFormats,
      vertexEntry,
      fragmentEntry,
      particleInputLanes,
      coverageOnly,
      constants,
    );
  };
  let activeProfile = freezeRenderProfile(
    internals.options?.standardProfile ?? DEFAULT_STANDARD_PROFILE,
  );
  // Recovery prewarm and live draws must select the same material ABI.
  const getMaterialShaderArtifact: NonNullable<
    RenderSystemInternals['getMaterialShaderArtifact']
  > = (materialShaderId, options = {}) =>
    resolveRendererMaterialShaderArtifact(
      materialShaderId,
      getShader(),
      pipelineState?.gpuDrivenPbrPrograms,
      typeof options === 'boolean' || activeProfile.visibleSurface !== true
        ? options
        : { ...options, visibleSurface: options.pass !== 'shadow' && options.pass !== 'depth' },
    );
  const getMaterialShaderPipelineEntry = (
    ...args: Parameters<typeof getMaterialShaderPipeline>
  ) => {
    const pipeline = getMaterialShaderPipeline(...args);
    if (pipeline === null) return null;
    const materialShaderId = args[0];
    const variantSet = args[5];
    const passKind = args[6] ?? 'forward';
    const vertexLayoutProjection = args[13];
    const layoutKind = args[15];
    const sceneIndexAddress =
      layoutKind === 'gpu-driven-pbr' ||
      layoutKind === 'gpu-driven-skin' ||
      layoutKind === 'gpu-driven-cluster-pbr' ||
      layoutKind === 'gpu-driven-cluster-skin';
    const artifact = getMaterialShaderArtifact(materialShaderId, {
      ...(vertexLayoutProjection === undefined
        ? {}
        : {
            vertexColorAvailable: vertexLayoutProjection.attributes.some(
              (attribute) => attribute.key === 'color',
            ),
          }),
      ...(layoutKind === 'pbr-skin' ||
      layoutKind === 'gpu-driven-skin' ||
      layoutKind === 'gpu-driven-cluster-skin'
        ? { deformation: 'skin' as const }
        : {}),
      ...(variantSet === undefined ? {} : { variantSet }),
      address: sceneIndexAddress ? 'scene-index' : 'direct',
      pass: passKind === 'shadow-caster' ? 'shadow' : 'forward',
    });
    return {
      pipeline,
      group2Contract:
        materialShaderPipelineGroup2Contracts.get(pipeline as object) ?? ('mesh' as const),
      ...(artifact?.receipt === undefined
        ? {}
        : {
            receipt: {
              identity: artifact.receipt.receiptIdentity,
              generation: artifact.receipt.generation,
            },
          }),
    };
  };
  const getParamSchema = (materialShaderId: string) => {
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    return lookup.ok ? lookup.value.paramSchema : undefined;
  };
  // feat-20260621-learn-render-5-5-parallax M2 / w6 (D-1): expose the per-shader
  // material BGL so the record stage creates the material bind group against
  // the matching paramSchema-derived layout. Returns undefined only for
  // group-0 / view-only contracts or an unavailable shader layout; built-in
  // material IDs continue to resolve through the shared layout path.
  const getMaterialBindGroupLayout = (
    materialShaderId: string,
    materialParamSchema?: readonly ParamSchemaEntry[],
  ): BindGroupLayout | undefined => {
    if (isEngineOwnedMaterialShader(materialShaderId)) return undefined;
    const contract = getCachedMaterialShaderBindingContract(materialShaderId);
    if (contract === 'group-0') {
      return getOrBuildGroup0MaterialLayout()?.materialBgl;
    }
    if (contract === 'group-0-resource') {
      return getOrBuildGroup0ResourceLayout(materialShaderId)?.materialBgl;
    }
    if (contract === 'view-and-scene-depth') return undefined;
    return (
      getOrBuildPerShaderMaterialLayout(materialShaderId, materialParamSchema)?.materialBgl ??
      undefined
    );
  };
  // feat-20260609 M4 / T-10-a: post-process pipeline factory backing
  // RenderSystemRuntime.getPostProcessPipeline. Solves M1 CONCERN-1: previously
  // the dispatcher in render-graph-primitives.ts passed `pipeline=null` to
  // built.createHandle because per-frame execute closures cannot await
  // device.createShaderModule (async). This factory uses the same shared
  // makeShaderDeviceAdapter the material-shader pipeline cache uses (sync
  // wrapper + 1-frame warmup); first-call returns null while the async compile
  // is in flight; second frame onward returns the built pipeline.
  //
  // The pipeline layout is fixed:
  //   group(0) = empty BGL (reserved per render-graph-primitives.ts convention
  //              for view bind groups; populated by future post-process passes
  //              that need view UBOs)
  //   group(1) = the input-texture BGL the dispatcher already composed via
  //              buildFullscreenPostProcessPass (texture + sampler)
  // Vertex stage: vs_main (no vertex buffers); fragment stage: fs_main targeting
  // `colorFormat`. Topology: triangle-list with cullMode='none' (3-vertex
  // fullscreen draw via the canonical fullscreen_triangle pattern).
  const buildPostProcessPipeline = (
    entry: PostProcessShaderEntry,
    bgl: BindGroupLayout,
    colorFormats: readonly GPUTextureFormat[],
    label: string,
  ): RenderPipeline | null => {
    const isFxaaPipeline = label.startsWith(`post-process-${FXAA_POST_PROCESS_ID}-pso-`);
    const moduleFactory = getShaderModuleAdapter();
    const moduleResult = moduleFactory.createShaderModule({
      code: entry.source,
      label: postProcessShaderModuleLabel(entry.source),
    });
    if (!moduleResult.ok) {
      // 'rhi-not-available' = async compile in flight: caller falls back one frame.
      // Other codes are real failures: surface through the error registry so AI
      // users see a structured RhiError instead of a silent black screen (charter P3).
      if (moduleResult.error.code !== 'rhi-not-available') {
        internals.errorRegistry.fire(moduleResult.error);
      }
      return null;
    }
    if (!isFxaaPipeline && entry.usesView !== true && currentEmptyPostProcessBgl() === null) {
      const bglRes = currentBuildDevice().createBindGroupLayout({ entries: [] });
      if (!bglRes.ok) {
        internals.errorRegistry.fire(bglRes.error);
        return null;
      }
      if (candidateBuildState !== undefined) {
        candidateBuildState.emptyPostProcessBgl = bglRes.value;
        candidateEmptyPostProcessBgl = bglRes.value;
      } else {
        emptyPostProcessBgl = bglRes.value;
      }
    }
    const viewLayout =
      entry.usesView === true ? currentPipelineState()?.viewBindGroupLayout : undefined;
    const group0Layout = viewLayout ?? currentEmptyPostProcessBgl();
    if (group0Layout === null || group0Layout === undefined) {
      internals.errorRegistry.fire(
        new Error('fullscreen post-process View layout is unavailable') as never,
      );
      return null;
    }
    const layoutRes = currentBuildDevice().createPipelineLayout({
      label: `${label}-layout`,
      bindGroupLayouts: isFxaaPipeline ? [bgl] : [group0Layout as BindGroupLayout, bgl],
    });
    if (!layoutRes.ok) {
      internals.errorRegistry.fire(layoutRes.error);
      return null;
    }
    const pipelineRes = currentBuildDevice().createRenderPipeline({
      label,
      layout: layoutRes.value,
      vertex: {
        module: moduleResult.value,
        entryPoint: 'vs_main',
        buffers: [],
      },
      fragment: {
        module: moduleResult.value,
        // The typed graph reuses the composed tonemap module for separate
        // linear-LDR and final-encoding passes.  Preserve the selected entry
        // point; forcing fs_main encodes the linear-LDR intermediate a second
        // time and breaks the Three.js stage contract.
        entryPoint: entry.fragmentEntryPoint ?? 'fs_main',
        targets: colorFormats.map((format) => ({ format })),
      },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: undefined,
      multisample: undefined,
    });
    if (!pipelineRes.ok) {
      internals.errorRegistry.fire(pipelineRes.error);
      return null;
    }
    return pipelineRes.value;
  };
  const renderInternals: RenderSystemInternals = {
    canvas: internals.canvas,
    get shaderRegistry() {
      return getShader();
    },
    get build() {
      return internals.bundler?.build;
    },
    ssrIdentity: internals.options?.ssrIdentity,
    captureReflectionFallbackReadback: internals.options?.captureReflectionFallbackReadback,
    get standardProfile() {
      return activeProfile;
    },
    standardPipeline: internals.options?.pipeline ?? standardPipeline,
    get featureHost() {
      return internals.featureHost;
    },
    setFeatureHost: (host) => {
      internals.featureHost = host;
    },
    // Resolve the adapter at call time so recovered devices get fresh modules.
    shaderModuleFactory: {
      createShaderModule: (descriptor) => getShaderModuleAdapter().createShaderModule(descriptor),
    },
    immediateShaderModuleFactory: {
      createShaderModule: (descriptor) =>
        getImmediateShaderModuleAdapter().createShaderModule(descriptor),
    },
    profiler: internals.options?.profiler,
    // Keep device/context getters live so recovery swaps are observed by the
    // record stage without reconstructing the RenderSystem.
    get device() {
      return internals.device;
    },
    get beforeSubmit() {
      return internals.pack.instrumentation?.beforeSubmit;
    },
    createShaderModule: (device, descriptor) =>
      internals.pack.createShaderModule === undefined
        ? Promise.resolve(invokeDeviceCreateShaderModule(device, descriptor))
        : internals.pack.createShaderModule(device, descriptor),
    get deviceScope() {
      return activeDeviceScope;
    },
    ...(internals.pack.instrumentation?.resolveSurfaceDevice === undefined
      ? {}
      : { resolveSurfaceDevice: internals.pack.instrumentation.resolveSurfaceDevice }),
    // The graph records receipt-bound color observations through the same
    // renderer-owned capture bridge consumed after queue submission. Keep the
    // identity and demand live on internals so recovery and per-frame graph
    // rebuilds observe the current device without reconstructing RenderSystem.
    get deviceGeneration() {
      return activeDeviceScope.generation;
    },
    get observationFrameId() {
      return internals.observationFrameId;
    },
    get observationGraphGeneration() {
      return internals.observationGraphGeneration;
    },
    set observationGraphGeneration(generation: number | undefined) {
      internals.observationGraphGeneration = generation;
    },
    get observationCaptureOwner() {
      return internals.observationCaptureOwner;
    },
    get observationCaptureDomains() {
      return internals.observationCaptureDomains;
    },
    invalidateShaderModule: (label: string) => {
      // Empty plans retire targets/bindings. Installed features retain shader
      // readiness until uninstall or device retirement so reactivation is immediate.
      if (
        requiredFullscreenPostProcesses.some(
          (entry) => postProcessShaderModuleLabel(entry.source) === label,
        )
      )
        return;
      activeShaderState.sharedShaderModuleAdapter?.invalidateModule(label);
    },
    get context() {
      return internals.context;
    },
    get debugOverlay() {
      return internals.debugOverlay;
    },
    // feat-20260608-create-app-param-surface-trim / M1 / AC-02: clearColor
    // is no longer threaded through createRenderSystem; the record stage
    // reads `camera.clearColor` straight from the Camera SoA column
    // (array<f32,4>, feat-20260709 M3).
    getPipelineState: () => pipelineState,
    assets,
    get gpuStore() {
      return gpuStore;
    },
    get dynamicTextureStore() {
      return dynamicTextureStore;
    },
    errorRegistry: internals.errorRegistry,
    healthRegistry: internals.healthRegistry,
    getMaterialShaderPipeline,
    getMaterialShaderPipelineEntry,
    getMaterialShaderBindingContract: getCachedMaterialShaderBindingContract,
    getMaterialShaderArtifact,
    getParamSchema,
    getMaterialBindGroupLayout,
    metrics,
    // createRenderSystem wraps this in a per-RenderSystem cache + the public
    // getPostProcessPipeline lookup the dispatcher reads at frame time.
    buildPostProcessPipeline,
    // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M3 / T-M3-04:
    // forward the grow hook + state via getter closures — buildReadyWebGPU
    // sets `internals.growMeshSsbo` / `internals.meshSsboState` after this
    // factory call, so the record stage reads them through the closures
    // (read at frame time, when ready has already settled).
    get growMeshSsbo() {
      return internals.growMeshSsbo;
    },
    get meshSsboState() {
      return internals.meshSsboState;
    },
    get gpuPassTimingSession() {
      return (
        internals as WebGPURendererInternals & {
          gpuPassTimingSession?: GpuPassTimingSession | undefined;
        }
      ).gpuPassTimingSession;
    },
    set gpuPassTimingSession(session: GpuPassTimingSession | undefined) {
      (
        internals as WebGPURendererInternals & {
          gpuPassTimingSession?: GpuPassTimingSession | undefined;
        }
      ).gpuPassTimingSession = session;
    },
    get gpuPassTimingCapture() {
      return (
        internals as WebGPURendererInternals & {
          gpuPassTimingCapture?: GpuPassTimingCapture | undefined;
        }
      ).gpuPassTimingCapture;
    },
    set gpuPassTimingCapture(capture: GpuPassTimingCapture | undefined) {
      (
        internals as WebGPURendererInternals & {
          gpuPassTimingCapture?: GpuPassTimingCapture | undefined;
        }
      ).gpuPassTimingCapture = capture;
    },
    get gpuPassTimingSubmittedWork() {
      return internals.gpuPassTimingSubmittedWork;
    },
    set gpuPassTimingSubmittedWork(completion: Promise<void> | undefined) {
      internals.gpuPassTimingSubmittedWork = completion;
    },
    get gpuPassTimingFrameIdentity() {
      return (
        internals as WebGPURendererInternals & {
          gpuPassTimingFrameIdentity?:
            | import('../record/gpu-pass-timing/session.js').GpuPassTimingFrameIdentity
            | undefined;
        }
      ).gpuPassTimingFrameIdentity;
    },
    set gpuPassTimingFrameIdentity(identity:
      | import('../record/gpu-pass-timing/session.js').GpuPassTimingFrameIdentity
      | undefined,) {
      (
        internals as WebGPURendererInternals & {
          gpuPassTimingFrameIdentity?:
            | import('../record/gpu-pass-timing/session.js').GpuPassTimingFrameIdentity
            | undefined;
        }
      ).gpuPassTimingFrameIdentity = identity;
    },
    get gpuPassTimingBeginReason() {
      return (
        internals as WebGPURendererInternals & {
          gpuPassTimingBeginReason?: GpuPassTimingReason | undefined;
        }
      ).gpuPassTimingBeginReason;
    },
    set gpuPassTimingBeginReason(reason: GpuPassTimingReason | undefined) {
      (
        internals as WebGPURendererInternals & {
          gpuPassTimingBeginReason?: GpuPassTimingReason | undefined;
        }
      ).gpuPassTimingBeginReason = reason;
    },
    getRenderTargetPhysical: (target) => renderTargetHost.getPhysicalTarget(target),
    markRenderTargetSubmitted: (target, physical) =>
      renderTargetHost.markTargetSubmitted(target, physical),
    resolveRenderTargetTextureSource: (source) =>
      renderTargetHost.resolveRenderTargetTextureSource(source),
    encodeRenderTargetReadbacks: (encoder, faces) =>
      renderTargetHost.encodePendingReadbacks(encoder, faces),
    get volumetricFogShaders() {
      return internals.volumetricFogShaders;
    },
    // Readiness-prewarmed SSR sources stay visible through the live internals seam.
    get ssrShaders() {
      return internals.ssrShaders;
    },
    get depthPyramidShaders() {
      return internals.depthPyramidShaders;
    },
    get standardDeferredShaders() {
      return internals.standardDeferredShaders;
    },
    get atmosphereShaders() {
      return internals.atmosphereShaders;
    },
  };
  const renderSystem: RenderSystem = createRenderSystem(renderInternals);
  const cameraViews = createCameraViews(renderInternals, renderSystem);
  internals.lossObserver.current = (detail) => {
    renderInternals.submittedPassNames = [];
    const code = detail.includes('destroyed') ? 'disposed' : 'device-lost';
    for (const continuation of frameContinuations) continuation.terminate({ code });
  };
  cameraViewsForTargetPromotion = cameraViews;
  attachGpuPassTimingSession(internals, gpuPassTimingSession);
  renderSystemForTargetPromotion = renderSystem;
  registerSingleLayerMediumBuiltins(renderSystem);
  if (
    internals.device.caps.backendKind === 'null' &&
    Array.from(getShader().entries()).length === 0
  ) {
    // RhiNull validates graph topology only; keep the built-in identity
    // registered so structural frames do not fail before graph inspection.
    renderSystem.registerBuiltinPostProcess(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, {
      source: '',
      params: { byteSize: 16, defaultValue: new Uint8Array(16) },
      reads: ['hdrColor'],
    });
  }
  // The Standard pipeline is the sole built-in graph owner. Feature plans are
  // projected into that graph directly; no second post-process registry is
  // installed for fullscreen producers.
  renderSystem.configureStandard(undefined);
  renderSystem.restorePostProcessResources();
  const attachedWorlds = new Set<World>();
  const attachedLeases = new Map<RenderReadLease, World>();
  const leasesByWorld = new Map<World, RenderReadLease>();
  const { lifecycle: dynamicGeometry, host: dynamicGeometryHost } =
    createRendererDynamicGeometryController({
      attachedWorlds,
      getGpuStore: () => gpuStore,
      currentGeneration: () => activeDeviceScope.generation,
      renderSystem: cameraViews,
    });
  const transformReleases = new Map<World, () => void>();
  const attachmentOwner = {};
  let frameId = 0;
  // Caller-owned receipts remain observable; Renderer does not retain every submitted receipt.
  const issuedReceipts = new WeakSet<FrameReceipt>();
  const receiptTimings = new WeakMap<FrameReceipt, Promise<VolumeTimingObservation>>();
  let latestReceipt: FrameReceipt | undefined;
  let pendingObservationDomains: readonly FrameObservationDomain[] | undefined;
  const observationOwner = createRendererObservationCaptureOwner((error) => {
    internals.errorRegistry.fire(error);
  });
  const {
    observationCaptureOwner,
    stats: observationStats,
    receiptObservationCaptures,
    receiptObservationBuffers,
    destroyedObservationBuffers,
    disposeObservationCaptures,
    disposeOwnedObservationCaptures,
    readObservationCapture,
    disposeReceiptObservationCaptures,
  } = observationOwner;
  Object.assign(internals, { observationCaptureOwner });
  const staleObservationReceipt = (receipt: FrameReceipt): FrameReceiptStaleError | undefined =>
    disposed ||
    !issuedReceipts.has(receipt) ||
    internals.healthRegistry.getLastSnapshot().reason === 'device-lost' ||
    receipt.deviceGeneration !== activeDeviceScope.generation ||
    receipt.backendId !== internals.device.caps.backendKind
      ? new FrameReceiptStaleError({
          frameId: receipt.frameId,
          receiptGeneration: receipt.deviceGeneration,
          currentGeneration: activeDeviceScope.generation,
        })
      : undefined;
  Object.defineProperty(internals, 'observationGraphGeneration', {
    configurable: true,
    get: () => observationOwner.expectedGraphGeneration,
    set: (generation: number | undefined) => {
      observationOwner.expectedGraphGeneration = generation;
    },
  });
  let surfaceReleased = false;
  const renderer: RendererAssemblyImplementation = {
    setSurfaceDynamicInput(frame) {
      cameraViews.setSurfaceDynamicInput(frame);
    },
    attach(world: World): RenderResult<RenderWorldLease, RenderError> {
      if (publicationReceiver !== undefined)
        return err(
          new RenderPublicationError({
            reason: 'identity',
            subject: 'publication Renderer has no World attachment',
          }),
        );
      const attached = this.attachScene(world);
      if (!attached.ok) {
        return err(new RendererContractFailureError('attach', attached.error.hint));
      }
      const lease = createRenderReadLease(world, attachmentOwner);
      attachedLeases.set(lease, world);
      leasesByWorld.set(world, lease);
      return ok(lease);
    },
    ...dynamicGeometryHost,
    createRenderTarget: (descriptor) => renderTargetHost.createRenderTarget(descriptor),
    resizeRenderTarget: (target, descriptor) =>
      renderTargetHost.resizeRenderTarget(target, descriptor),
    createRenderTargetTextureSource: (target, options) =>
      renderTargetHost.createRenderTargetTextureSource(target, options),
    requestTargetReadback: (target, request) =>
      renderTargetHost.requestTargetReadback(target, request),
    destroyRenderTarget: (target) => renderTargetHost.destroyRenderTarget(target),
    setProfile(profile: RenderProfile): RenderResult<void, RenderError> {
      const invalid = validateRenderProfile(profile);
      if (invalid !== undefined) {
        return err(
          new RendererOperationError('frame-input-invalid', {
            operation: 'set-profile',
            cause: new RendererContractFailureError('draw', invalid),
          }),
        );
      }
      const previous = activeProfile;
      activeProfile = freezeRenderProfile(profile);
      try {
        cameraViews.configureStandard(undefined);
        return ok(undefined);
      } catch (cause) {
        activeProfile = previous;
        try {
          cameraViews.configureStandard(undefined);
        } catch {
          // The original structured profile failure remains authoritative.
        }
        return err(
          new RendererOperationError('graph-build-failed', {
            operation: 'set-profile',
            cause: structuredRendererCause(cause, 'set-profile'),
          }),
        );
      }
    },
    inspectLodOcclusion() {
      const inspectedSystem = cameraViews.currentSystem;
      return {
        lodOcclusion: inspectedSystem.lodOcclusionInspection,
        gpuDriven: inspectedSystem.gpuDrivenInspection,
      };
    },
    bounds: (world, entity) => (disposed ? undefined : cameraViews.bounds(world, entity)),
    inspect(): RenderInspection {
      const inspectedSystem = cameraViews.currentSystem;
      const health = internals.healthRegistry.getLastSnapshot();
      const deviceLost = health.reason === 'device-lost';
      const state = disposed
        ? 'disposed'
        : deviceLost
          ? 'device-lost'
          : health.reason === 'internal-fault' || !readySettled
            ? 'faulted'
            : 'alive';
      const graph = deviceLost ? undefined : inspectedSystem.perFrameGraphInfo;
      const graphResourceAllocation = graph?.resourceAllocation;
      const graphGenerationAllocation = deviceLost
        ? undefined
        : inspectedSystem.renderGraphGenerationAllocation;
      const standardLighting = deviceLost ? undefined : inspectedSystem.standardLightingInspection;
      const barrelDistortion = inspectBarrelDistortion(
        disposed,
        deviceLost,
        surfaceReleased,
        frameId,
        activeDeviceScope.generation,
        inspectedSystem.barrelDistortionInspection,
      );
      const bloom: BloomInspection = deviceLost ? emptyBloomInspection() : inspectedSystem.bloom;
      const observationId = `${STANDARD_OUTPUT_TRANSFORM_FEATURE_ID}:frame-${frameId}`;
      const outputInspection = projectRendererOutputInspectionFromSurface({
        graph,
        surfaceReleased,
        pipelineState,
        rgba16floatRenderable: internals.device.caps.rgba16floatRenderable,
        autoExposure: inspectedSystem.autoExposure,
        standardLut: inspectedSystem.standardLut,
        presentationProof: internals.context?.presentationProof,
      });
      const volumetricFog = inspectedSystem.volumetricFog;
      const directionalShadow = inspectedSystem.directionalShadow;
      const shadowRaster = inspectedSystem.shadowRaster;
      const recoveryEvidence = inspectedSystem.recoveryEvidence;
      const pointShadow = projectPointShadowInspection(
        inspectedSystem.pointShadowInspection,
        materialShadersSamplePointShadows(getShader().materialShaderManifestEntries()),
      );
      return Object.freeze({
        state,
        views: cameraViews.inspect(),
        recovery: recoveryInspection,
        surface: surfaceReleased ? 'released' : 'available',
        profile: activeProfile,
        capabilities: Object.freeze({ ...internals.device.caps }),
        frame: Object.freeze({
          frameId,
          deviceGeneration: activeDeviceScope.generation,
        }),
        barrelDistortion,
        ...projectRendererFeatureInspection(internals.featureHost),
        featureGraph: inspectedSystem.featureGraphInspection,
        materialTextureSources: inspectedSystem.materialTextureSources,
        frustumStats: Object.freeze({ ...inspectedSystem.frustumStats }),
        visibilityStats: Object.freeze({ ...inspectedSystem.visibilityStats }),
        instanceCollections: Object.freeze(
          inspectedSystem.instanceCollectionsInspection.map((collection) =>
            Object.freeze({
              ...collection,
              uploadRanges: Object.freeze(
                collection.uploadRanges.map((range) => Object.freeze({ ...range })),
              ),
              ...(collection.error === undefined
                ? {}
                : {
                    error: Object.freeze({
                      ...collection.error,
                      detail: Object.freeze({ ...collection.error.detail }),
                    }),
                  }),
            }),
          ),
        ),
        dynamicGeometry: dynamicGeometry.inspect(),
        renderScene: inspectedSystem.renderScene,
        ...(graphResourceAllocation === undefined
          ? {}
          : { renderGraphResourceAllocation: graphResourceAllocation }),
        ...(graphGenerationAllocation === undefined
          ? {}
          : { renderGraphGenerationAllocation: graphGenerationAllocation }),
        ...(inspectedSystem.iblBinding === undefined
          ? {}
          : { iblBinding: inspectedSystem.iblBinding }),
        reflectionProbes: inspectedSystem.reflectionProbes,
        ssrDependencies: inspectedSystem.ssrDependencies,
        ssr: inspectedSystem.ssr,
        ...(inspectedSystem.diffuseGi === undefined
          ? {}
          : { diffuseGi: inspectedSystem.diffuseGi }),
        volumetricFog,
        environment: inspectedSystem.environment,
        temporal: inspectedSystem.temporal,
        ...(inspectedSystem.dynamicResolution === undefined
          ? {}
          : { dynamicResolution: inspectedSystem.dynamicResolution }),
        bloom,
        extendedLighting: projectExtendedLightingInspection(extendedLightingState),
        directionalShadow,
        shadowRaster,
        ...(inspectedSystem.temporalTargetInspection === undefined
          ? {}
          : { temporalTarget: Object.freeze(inspectedSystem.temporalTargetInspection) }),
        ...(inspectedSystem.motionBlurInspection === undefined
          ? {}
          : { motionBlur: Object.freeze(inspectedSystem.motionBlurInspection) }),
        ...dofInspection(inspectedSystem.depthOfFieldInspection),
        ...(inspectedSystem.lodOcclusionInspection === undefined
          ? {}
          : { lodOcclusion: Object.freeze(inspectedSystem.lodOcclusionInspection) }),
        ...(inspectedSystem.transmission === undefined
          ? {}
          : { transmission: inspectedSystem.transmission }),
        ...(standardLighting === undefined
          ? {}
          : { standardLighting: Object.freeze({ ...standardLighting }) }),
        ...(pointShadow === undefined ? {} : { pointShadow: Object.freeze({ ...pointShadow }) }),
        ...(inspectedSystem.capsuleShadowInspection === undefined
          ? {}
          : { capsuleShadow: inspectedSystem.capsuleShadowInspection }),
        ...(inspectedSystem.transparencyInspection === undefined
          ? {}
          : { transparency: inspectedSystem.transparencyInspection }),
        meshMaterialBindings: Object.freeze(
          inspectedSystem.meshMaterialBindings.map((observation) =>
            Object.freeze({
              ...observation,
              bindings: Object.freeze(
                observation.bindings.map((binding) => Object.freeze({ ...binding })),
              ),
              diagnostics: Object.freeze(
                observation.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
              ),
            }),
          ),
        ),
        perFramePassNames: Object.freeze([...cameraViews.perFramePassNames]),
        bindGroupCounts: Object.freeze({
          createBindGroup: inspectedSystem.bindGroupCounts.createBindGroup,
          keys: Object.freeze([...inspectedSystem.bindGroupCounts.keys]),
        }),
        recoveryEvidence: Object.freeze({
          ...recoveryEvidence,
          graph: deviceLost
            ? { ready: false, generation: 0, passCount: 0, resourceCount: 0 }
            : recoveryEvidence.graph,
          producerRoots: Object.freeze([...recoveryEvidence.producerRoots]),
          receipts: Object.freeze({
            count: frameId,
            lastGeneration: latestReceipt?.deviceGeneration,
          }),
        }),
        output: Object.freeze({
          ...outputInspection,
          graphPassNames: Object.freeze([...outputInspection.graphPassNames]),
          ...(outputInspection.standardOutputColor === undefined
            ? {}
            : { standardOutputColor: Object.freeze({ ...outputInspection.standardOutputColor }) }),
        }),
        observation: Object.freeze({
          observationId,
          frameId,
          ...(inspectedSystem.lastSuccessfulCameraAntialias === undefined
            ? {}
            : { antialias: inspectedSystem.lastSuccessfulCameraAntialias }),
          ...(outputInspection.surfaceProfile === undefined
            ? {}
            : { surfaceProfile: outputInspection.surfaceProfile }),
          rgba16floatRenderable: internals.device.caps.rgba16floatRenderable,
          passNames: Object.freeze([...outputInspection.graphPassNames]),
          ...(outputInspection.standardOutputColor === undefined
            ? {}
            : { standardOutputColor: Object.freeze({ ...outputInspection.standardOutputColor }) }),
          resourceStats: Object.freeze({
            allocationCount: observationStats.allocationCount,
            liveCount: observationStats.liveCount,
            peakLiveCount: observationStats.peakLiveCount,
            mapCount: observationStats.mapCount,
            readbackCount: observationStats.readbackCount,
            liveByteLength: observationStats.liveByteLength,
          }),
        }),
      });
    },
    get device(): RhiDevice {
      return internals.device;
    },
    // Keep engine-owned shader consumers on the exact backend pack selected
    // for this renderer. Importing a backend adapter again from a
    // feature glue module can produce a second bundled module instance whose
    // RAW_DEVICE_MAP does not contain this opaque RhiDevice handle.
    _internal_createShaderModule:
      internals.pack.createShaderModule ??
      ((device, desc) => invokeDeviceCreateShaderModule(device, desc)),
    _internal_setRenderOverlay(overlay) {
      if (overlay === undefined) {
        delete internals.debugOverlay;
      } else {
        internals.debugOverlay = overlay;
      }
    },
    assetRegistry: assets,
    initialization: ready,
    attachScene(world: World): Result<void, RhiError> {
      if (disposed) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'renderer not disposed before attaching a World',
            hint: 'rebuild the renderer before attaching another World',
          }),
        );
      }
      if (attachedWorlds.has(world)) return ok(undefined);
      try {
        transformReleases.set(world, registerRenderSourceSystems(world, assets, gpuStore));
        attachedWorlds.add(world);
        return ok(undefined);
      } catch (cause) {
        const error = new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'renderer.attach(world) installs derived-state systems once',
          hint: 'inspect the World schedule registration or derived-state system failure',
          detail: {
            error: {
              code: 'unknown',
              message: cause instanceof Error ? cause.message : String(cause),
              ...(cause instanceof Error ? { name: cause.name } : {}),
            },
          },
        });
        internals.errorRegistry.fire(error);
        return err(error);
      }
    },
    detachScene(world: World): void {
      if (!attachedWorlds.delete(world)) return;
      dynamicGeometryHost.invalidateDynamicGeometryWorld(world);
      for (const [lease, leaseWorld] of attachedLeases) {
        if (leaseWorld === world) {
          lease.dispose();
          attachedLeases.delete(lease);
          leasesByWorld.delete(world);
        }
      }
      renderSystem.detachScene(world);
      cameraViews.detach(world);
      transformReleases.get(world)?.();
      transformReleases.delete(world);
    },
    observeCurrentFrame(options: FrameObservationOptions) {
      return cameraViews.currentSystem.observeCurrentFrame(options);
    },
    requestObservation(
      domains: readonly FrameObservationDomain[],
    ): RenderResult<void, RenderError> {
      if (disposed) {
        return err(
          new RendererOperationError('renderer-state-invalid', {
            operation: 'request-observation',
            state: 'disposed',
          }),
        );
      }
      if (
        !Array.isArray(domains) ||
        domains.length === 0 ||
        domains.some((domain) => !isFrameObservationDomain(domain)) ||
        new Set(domains).size !== domains.length
      ) {
        return err(
          new RendererOperationError('frame-input-invalid', {
            operation: 'request-observation',
            cause: new RendererContractFailureError(
              'request-observation',
              'domains must be a non-empty set of supported observation domains',
            ),
          }),
        );
      }
      if (domains.includes('visible-surface') && activeProfile.visibleSurface !== true) {
        return err(
          new RendererContractFailureError(
            'request-observation',
            'enable the Standard visibleSurface profile before arming its observation',
          ),
        );
      }
      if (receiptObservationBuffers.size >= 4) {
        return err(
          new RendererContractFailureError(
            'request-observation',
            'four unread frame observations are retained; observe their receipts before requesting another',
          ),
        );
      }
      pendingObservationDomains = Object.freeze([...domains]);
      return ok(undefined);
    },
    getCurrentGraphTarget(name: string) {
      return cameraViews.currentSystem.getCurrentGraphTarget(name);
    },
    requestGraphTargetCapture(request) {
      cameraViews.currentSystem.requestGraphTargetCapture(request);
    },
    get frustumStats() {
      return cameraViews.currentSystem.frustumStats;
    },
    get visibilityStats() {
      return cameraViews.currentSystem.visibilityStats;
    },
    get renderScene() {
      return cameraViews.currentSystem.renderScene;
    },
    get meshMaterialBindings() {
      return cameraViews.currentSystem.meshMaterialBindings;
    },
    get perFramePassNames() {
      return cameraViews.perFramePassNames;
    },
    get bindGroupCounts() {
      return cameraViews.currentSystem.bindGroupCounts;
    },
    configureStandard(config) {
      cameraViews.configureStandard(config);
    },
    renderFeatureDiagnostics() {
      return internals.featureHost?.diagnostics() ?? [];
    },
    async installRenderFeature(
      feature: RenderFeature<unknown>,
    ): Promise<RenderResult<void, RenderError>> {
      if (disposed) {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'extract', 'registration'),
        );
      }
      const host = internals.featureHost;
      if (host === undefined) {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'extract', 'registration'),
        );
      }
      const missingCapability = feature.requiredCapabilities?.find(
        (capability) => internals.device.caps[capability] !== true,
      );
      if (missingCapability !== undefined) {
        return err(
          new RenderFeatureCapabilityMissingError(feature.identity, host.size, missingCapability),
        );
      }
      let nextRequiredFullscreenPostProcesses: readonly {
        readonly identity: string;
        readonly source: string;
      }[];
      try {
        nextRequiredFullscreenPostProcesses = collectRequiredFullscreenPostProcesses([
          ...host.features,
          feature,
        ]);
      } catch (cause) {
        const conflict =
          cause instanceof RhiError
            ? cause
            : new RhiError({
                code: 'internal-error',
                expected: 'fullscreen feature declarations are internally consistent',
                hint: 'repair the conflicting fullscreen identity/source declarations',
              });
        internals.errorRegistry.fire(conflict);
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
        );
      }
      const fullscreenPrewarm = await prewarmFullscreenFeatureModules(feature);
      if (!fullscreenPrewarm.ok) {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
        );
      }
      for (const materialShaderId of feature.requiredMaterialShaders ?? []) {
        const lookup = getShader().findMaterialArtifact(materialShaderId);
        if (!lookup.ok) {
          const error = new RhiError({
            code: 'shader-compile-failed',
            expected: `declared render feature material shader '${materialShaderId}' is present in the loaded manifest`,
            hint: `add material shader '${materialShaderId}' to the shader manifest or remove it from the feature declaration`,
          });
          internals.errorRegistry.fire(error);
          return err(
            new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
          );
        }
        const label = `module-${materialShaderId}`;
        const moduleResult = internals.pack.createShaderModule
          ? await internals.pack.createShaderModule(internals.device, {
              code: lookup.value.source,
              label,
            })
          : await invokeDeviceCreateShaderModule(internals.device, {
              code: lookup.value.source,
              label,
            });
        if (!moduleResult.ok) {
          internals.errorRegistry.fire(moduleResult.error);
          return err(
            new RenderFeatureStageFailedError(feature.identity, -1, 'prepare', 'registration'),
          );
        }
        getShaderModuleAdapter().seedModule(label, moduleResult.value);
      }
      const installed = host.install(feature);
      if (!installed.ok) return installed;
      if (installed.ok) {
        for (const materialShaderId of feature.requiredMaterialShaders ?? []) {
          requiredMaterialShaderSet.add(materialShaderId);
        }
        requiredMaterialShaders = Object.freeze([...requiredMaterialShaderSet]);
        requiredFullscreenPostProcesses = nextRequiredFullscreenPostProcesses;
        cameraViews.reset();
      }
      return installed;
    },
    async uninstallRenderFeature(
      feature: RenderFeature<unknown>,
    ): Promise<RenderResult<void, RenderError>> {
      const host = internals.featureHost;
      if (disposed || host === undefined) {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'dispose', 'registration'),
        );
      }
      try {
        await internals.device.queue.onSubmittedWorkDone();
      } catch {
        return err(
          new RenderFeatureStageFailedError(feature.identity, -1, 'dispose', 'registration'),
        );
      }
      const removed = host.uninstall(feature);
      if (removed.ok) {
        requiredMaterialShaderSet.clear();
        for (const remaining of host.features) {
          for (const materialShaderId of remaining.requiredMaterialShaders ?? []) {
            requiredMaterialShaderSet.add(materialShaderId);
          }
        }
        requiredMaterialShaders = Object.freeze([...requiredMaterialShaderSet]);
        requiredFullscreenPostProcesses = collectRequiredFullscreenPostProcesses(host.features);
        cameraViews.reset();
      }
      return removed;
    },
    drawFrame(request: RenderFrameInput): RenderResult<FrameReceipt, RhiError | RenderError> {
      const result = this.draw(request);
      if (!result.ok) return result;
      return result.value === undefined
        ? err(
            new RendererContractFailureError(
              'draw',
              'the lease-bound draw path must return a FrameReceipt after submit',
            ),
          )
        : ok(result.value);
    },
    draw(
      worldsOrRequest: readonly World[] | RenderFrameInput | PublishedRenderFrameInput,
      options?: DrawOwnerOptions,
    ): Result<void | FrameReceipt, RhiError | RenderError> {
      const isFrameRequest = !Array.isArray(worldsOrRequest);
      const publicationRequest =
        isFrameRequest && 'publication' in worldsOrRequest
          ? (worldsOrRequest as PublishedRenderFrameInput)
          : undefined;
      const frameRequest =
        isFrameRequest && publicationRequest === undefined
          ? (worldsOrRequest as RenderFrameInput)
          : undefined;
      let publication: PreparedRenderPublication | undefined;
      if (publicationRequest !== undefined) {
        if (publicationReceiver === undefined)
          return err(
            new RenderPublicationError({
              reason: 'identity',
              subject: 'RendererOptions.publicationSource',
            }),
          );
      } else if (publicationReceiver !== undefined) {
        return err(
          new RenderPublicationError({
            reason: 'identity',
            subject: 'a publication-bound renderer cannot consume local World leases',
          }),
        );
      }
      const worlds: readonly World[] =
        frameRequest !== undefined
          ? frameRequest.leases
              .map((lease) => attachedLeases.get(lease))
              .filter((world): world is World => world !== undefined)
          : publicationRequest === undefined
            ? (worldsOrRequest as readonly World[])
            : [];
      const readLeases: readonly RenderReadLease[] | undefined =
        frameRequest !== undefined
          ? frameRequest.leases
          : worlds.map((world) => leasesByWorld.get(world)).every((lease) => lease !== undefined)
            ? worlds.map((world) => leasesByWorld.get(world) as RenderReadLease)
            : undefined;
      const physicsFrameError = derivedPhysicsFrameError(worlds);
      if (physicsFrameError !== undefined) return err(physicsFrameError);
      if (frameRequest !== undefined && worlds.length !== frameRequest.leases.length) {
        return err(
          new RendererOperationError('world-lease-invalid', {
            operation: 'draw',
            cause: new RendererContractFailureError(
              'draw',
              'every RenderFrameInput lease must be attached to this Renderer',
            ),
          }),
        );
      }
      const cameraOwner =
        frameRequest === undefined ? -1 : frameRequest.leases.indexOf(frameRequest.camera.lease);
      const resourceOwner =
        frameRequest === undefined
          ? -1
          : frameRequest.leases.indexOf(frameRequest.environment.lease);
      if (frameRequest !== undefined && (cameraOwner < 0 || resourceOwner < 0)) {
        return err(
          new RendererOperationError('frame-input-invalid', {
            operation: 'draw',
            cause: new RendererContractFailureError(
              'draw',
              cameraOwner < 0
                ? 'camera lease must be present in RenderFrameInput.leases'
                : 'environment lease must be present in RenderFrameInput.leases',
            ),
          }),
        );
      }
      const drawOptions: DrawOwnerOptions =
        frameRequest !== undefined
          ? {
              cameraOwner,
              resourceOwner,
              ...(frameRequest.camera.entityKey === undefined
                ? {}
                : { cameraEntityKey: frameRequest.camera.entityKey }),
              ...motionBlurDrawOptions(frameRequest),
              ...(frameRequest.profileFrame === undefined
                ? {}
                : { profileFrame: frameRequest.profileFrame }),
              ...(frameRequest.geometryLane === undefined
                ? {}
                : { geometryLane: frameRequest.geometryLane }),
            }
          : publicationRequest === undefined
            ? (options ?? { cameraOwner: 0, resourceOwner: 0 })
            : {
                cameraOwner: 0,
                resourceOwner: 0,
                sampleTimeSeconds: publicationRequest.publication.sampleTimeSeconds,
                temporalReset: publicationRequest.publication.temporalReset,
              };
      // feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5 / w21
      // (plan-strategy D-1, D-8): post-dispose the renderer is dead. AI
      // users observing `result.ok === false && err.code === 'rhi-not-
      // available'` know to rebuild the renderer (mirrors the "ready not
      // settled" + "pipelineState null" fail-fast paths below; reuses the
      // existing closed-union member, no new ErrorCode introduced).
      if (disposed) {
        const e = new RhiError({
          code: 'rhi-not-available',
          expected:
            'renderer not disposed before calling renderer.draw(worlds, { cameraOwner, resourceOwner })',
          hint: 'renderer.dispose() flipped the lifecycle latch; rebuild via createRenderer / Engine.create',
        });
        internals.errorRegistry.fire(e);
        return err(e);
      }
      if (surfaceReleased) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'renderer surface restored before drawing',
            hint: 'call renderer.restoreSurface() after the temporary surface owner stops',
          }),
        );
      }
      const canvasSizeError = rejectZeroCanvasSize(internals.canvas.width, internals.canvas.height);
      if (canvasSizeError !== undefined) return err(canvasSizeError);
      // M2 / w9 (A-IN-5): device-lost guard — draw() silently returns err
      // without firing onError each frame. The device-lost channel fires once
      // through the dual-channel fan-out (:750-797); draw() does not repeat it
      // (canvas holds previous frame). Host observes health().reason ===
      // 'device-lost' and calls recover() when ready.
      if (internals.healthRegistry.getLastSnapshot().reason === 'device-lost') {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'GPUDevice is lost; recover() to rebuild and resume rendering',
            hint: 'call renderer.recover() after a host-chosen delay; camera holds previous frame',
          }),
        );
      }
      // D-S4: ready not settled => fire onError + skip frame. Uses
      // 'rhi-not-available' (closed union placeholder semantics; charter
      // proposition 4 explicit failure - AI users observe through onError
      // and decide whether to retry).
      if (!readySettled) {
        const e = new RhiError({
          code: 'rhi-not-available',
          expected:
            'await renderer.initialization before calling renderer.draw(worlds, { cameraOwner, resourceOwner })',
          hint: 'await renderer.initialization resolves once the manifest / pipeline / asset upload chain completes',
        });
        internals.errorRegistry.fire(e);
        return err(e);
      }
      // pipeline build rejected: ready Promise has already surfaced the
      // structured error to AI users through `await renderer.initialization`. Skip
      // to keep draw(world) idempotent; a transient retry next frame is
      // the responsibility of the AI user (charter proposition 9).
      if (pipelineState === null) {
        const e = new RhiError({
          code: 'rhi-not-available',
          expected: 'pipelineState built during Renderer.initialization',
          hint: 'await renderer.initialization resolved successfully; rebuild renderer or fix the upstream RhiError',
        });
        internals.errorRegistry.fire(e);
        return err(e);
      }
      // feat-20260708-composited-multi-world-rendering M3 / D-5: draw-args
      // entry validation runs before each extract or context configuration.
      // Empty worlds / owner out of range returns a structured Result.err
      // (never silent, charter P3) without touching GPU state. The two codes
      // are non-exclusive: an empty array short-circuits to empty-worlds. The
      // check is defensive against JS callers passing a non-array despite the
      // compile-time World[] type (red-window migration safety).
      const worldCount =
        publicationRequest === undefined ? (Array.isArray(worlds) ? worlds.length : 0) : 1;
      if (worldCount === 0 && internals.device.caps.backendKind === 'null') {
        return ok(undefined);
      }
      // Validate both owner indices (cameraOwner before resourceOwner, first
      // offender wins). The empty object only protects the JS boundary; it is
      // rejected by the same validation and never becomes another draw shape.
      const drawOwners = drawOptions;
      const argsCheck = validateDrawArgs(worldCount, drawOwners);
      if (!argsCheck.ok) {
        internals.errorRegistry.fire(argsCheck.error);
        return argsCheck;
      }
      // Configure context lazily on first draw (D-S1 single-point
      // exemption): GPUCanvasContext.configure({device}) needs a raw
      // The canvas context is configured through the RHI device scope.
      const contextConfigured = ensureContextConfigured(
        internals,
        pipelineState,
        internals.errorRegistry,
      );
      if (!contextConfigured.ok) return contextConfigured;
      // w24 — facade-level try/catch produces Result.err on unexpected throw
      // (D-P6 dual-channel preserved: per-stage RhiError continues to fan out
      // through onError separately; the facade Result is the synchronous
      // summary AI users can ignore or branch on).
      try {
        if (publicationRequest !== undefined && publicationReceiver !== undefined) {
          const accepted = publicationReceiver.accept(publicationRequest.publication);
          if (!accepted.ok) return accepted;
          publication = {
            ...accepted.value,
            ...(publicationRequest.onFeatureSourceSubmitted === undefined
              ? {}
              : {
                  onFeatureSourceSubmitted: publicationRequest.onFeatureSourceSubmitted,
                }),
          };
          installPublicationPrograms(assets, publicationRequest.publication.programs);
        }
        renderTargetHost.beginFrame();

        const timingHost = internals;
        const timingRequested =
          isFrameRequest &&
          (frameRequest?.profileFrame !== undefined ||
            internals.options?.captureGpuTimings === true);
        let volumeTimingCapture: GpuTimingCapture | undefined;
        const volumeTimingUnavailableReason = timingRequested
          ? 'timestamp capture is unavailable on this device'
          : 'timestamp capture was not requested for this frame';
        if (timingRequested && gpuPassTimingOptions === undefined) {
          const createdTiming = GpuTimingCapture.create(internals.device);
          if (createdTiming.ok) volumeTimingCapture = createdTiming.value;
        }
        if (isFrameRequest) {
          timingHost.observationFrameId = frameId + 1;
          timingHost.observationGraphGeneration = undefined;
          timingHost.observationCaptureDomains = pendingObservationDomains;
          timingHost.gpuPassTimingFrameIdentity = {
            frameId: frameId + 1,
            deviceGeneration: activeDeviceScope.generation,
            graphGeneration: 0,
          };
        }
        const submitted = cameraViews.draw(
          worlds,
          drawOptions,
          readLeases,
          volumeTimingCapture,
          publication === undefined || publicationReceiver === undefined
            ? undefined
            : { publication, receiver: publicationReceiver },
        );
        timingHost.observationFrameId = undefined;
        timingHost.observationCaptureDomains = undefined;
        timingHost.gpuPassTimingFrameIdentity = undefined;
        if (!submitted) {
          const cleanupFailure = disposeOwnedObservationCaptures(observationCaptureOwner.drain());
          volumeTimingCapture?.discard();
          if (cleanupFailure !== undefined) return err(cleanupFailure);
          const invalidMotionBlur = cameraViews.currentSystem.motionBlurInvalidParams;
          if (invalidMotionBlur !== undefined) return err(invalidMotionBlur);
          return err(
            new RendererContractFailureError(
              'draw',
              'the Standard render owner did not submit a command buffer; inspect Renderer error events and recover the owning frame path',
            ),
          );
        }
        const timingCompletion = timingHost.gpuPassTimingSubmittedWork;
        timingHost.gpuPassTimingSubmittedWork = undefined;
        const reflectionFallbackCompletion = cameraViews.currentSystem.reflectionFallbackCompletion;
        const queueCompletion = timingCompletion ?? internals.device.queue.onSubmittedWorkDone();
        gpuStore.trackMeshSubmission(queueCompletion);
        internals.pack.instrumentation?.onFrameBoundary?.();
        if (!isFrameRequest) {
          const cleanupFailure = disposeOwnedObservationCaptures(observationCaptureOwner.drain());
          renderTargetHost.onFrameSubmitted(
            queueCompletion.then(() => ({ ok: true, value: undefined }) as const),
          );
          if (cleanupFailure !== undefined) return err(cleanupFailure);
          return ok(undefined);
        }
        const receiptFrameId = ++frameId;
        const receiptGeneration = activeDeviceScope.generation;
        const completion: FrameReceipt['completed'] = Promise.all([
          queueCompletion,
          reflectionFallbackCompletion ?? Promise.resolve(),
        ])
          .then(() => ok(undefined))
          .catch((cause: unknown) =>
            err(
              new RendererOperationError('device-operation-failed', {
                operation: 'complete-frame',
                frameId: receiptFrameId,
                deviceGeneration: receiptGeneration,
                cause: structuredRendererCause(cause, 'complete-frame'),
              }),
            ),
          );
        const continuation = createContinuationTerminator();
        frameContinuations.add(continuation);
        const guardedCompletion = guardFrameCompletion(
          completion,
          () => continuation.guard('queue-completion'),
          () =>
            new RendererOperationError('device-operation-failed', {
              operation: 'complete-frame',
              frameId: receiptFrameId,
              deviceGeneration: receiptGeneration,
              cause: structuredRendererCause(
                {
                  code: 'stale-generation',
                  expected: 'frame completion belongs to its device generation',
                  hint: 'discard the stale receipt',
                },
                'complete-frame',
              ),
            }),
          (cause: unknown) =>
            new RendererOperationError('device-operation-failed', {
              operation: 'complete-frame',
              frameId: receiptFrameId,
              deviceGeneration: receiptGeneration,
              cause: structuredRendererCause(cause, 'complete-frame'),
            }),
        );
        const terminated = continuation.promise().then((reason) =>
          err(
            new RendererOperationError('device-operation-failed', {
              operation: 'complete-frame',
              frameId: receiptFrameId,
              deviceGeneration: receiptGeneration,
              cause: structuredRendererCause(
                {
                  code: reason.code,
                  expected: 'a frame continuation completes before device loss or disposal',
                  hint: 'discard the stale receipt and inspect the current renderer generation',
                  detail: reason,
                },
                'complete-frame',
              ),
            }),
          ),
        );
        const completed: FrameReceipt['completed'] = Promise.race([
          guardedCompletion,
          terminated,
        ]).finally(() => {
          frameContinuations.delete(continuation);
        });
        const captures = observationCaptureOwner.consume(receiptFrameId);
        pendingObservationDomains = undefined;
        const receiptGraphGeneration =
          timingHost.observationGraphGeneration ??
          cameraViews.currentSystem.perFrameGraphInfo?.generation ??
          0;
        const receipt = Object.freeze({
          frameId: receiptFrameId,
          deviceGeneration: receiptGeneration,
          presentation: cameraViews.presentation ?? renderSystem.presentation,
          backendId: internals.device.caps.backendKind,
          graphGeneration: receiptGraphGeneration,
          ...(cameraViews.active || renderSystem.lastSuccessfulBarrelDistortion === undefined
            ? {}
            : { barrelDistortion: renderSystem.lastSuccessfulBarrelDistortion }),
          completed,
        });
        renderTargetHost.onFrameSubmitted(completed, receipt);
        latestReceipt = receipt;
        if (captures.length > 0) {
          const captureRead: ObservationCaptureRead = async () => {
            const completion = await completed;
            if (!completion.ok) {
              const cleanupFailure = disposeObservationCaptures(captures);
              return cleanupFailure === undefined ? completion : err(cleanupFailure);
            }
            const read = [];
            for (const capture of captures) {
              const bytes = await readObservationCapture(capture);
              if (!bytes.ok) {
                const cleanupFailure = disposeObservationCaptures(captures);
                return cleanupFailure === undefined ? bytes : err(cleanupFailure);
              }
              read.push({ capture, bytes: bytes.value });
            }
            return ok(read);
          };
          receiptObservationBuffers.set(receipt, captures);
          receiptObservationCaptures.set(receipt, captureRead);
        }
        const passTimingCapture = timingHost.gpuPassTimingCapture;
        const timingBeginReason = timingHost.gpuPassTimingBeginReason;
        const timingSource =
          passTimingCapture === undefined
            ? gpuPassTimingUnavailable === undefined && timingBeginReason === undefined
              ? undefined
              : async (): Promise<GpuPassTimingObservation> =>
                  gpuPassTimingUnavailable ??
                  failedGpuPassTimingObservation(timingBeginReason as GpuPassTimingReason)
            : async (): Promise<GpuPassTimingObservation> => {
                const observed = await passTimingCapture.observe();
                if (!observed.ok) return failedGpuPassTimingObservation(observed.error);
                const frame = observed.value;
                const unmeasured = frame.passes.find((pass) => pass.status === 'unmeasured');
                if (unmeasured !== undefined) {
                  return { status: 'partial', frame, reason: unmeasured.reason };
                }
                if (frame.droppedPassCount > 0) {
                  return {
                    status: 'partial',
                    frame,
                    reason: {
                      code: 'query-budget-exceeded',
                      expected: 'all executed passes fit within the bounded query budget',
                      hint: 'increase maxPassesPerFrame or simplify the pass graph',
                      detail: { droppedPassCount: frame.droppedPassCount },
                    },
                  };
                }
                return { status: 'complete', frame };
              };
        timingObservationStore?.register(receipt, timingSource);
        if (timingRequested && gpuPassTimingOptions === undefined) {
          receiptTimings.set(
            receipt,
            volumeTimingCapture?.observation() ??
              Promise.resolve({
                status: 'unavailable',
                reason: volumeTimingUnavailableReason,
              }),
          );
        }
        issuedReceipts.add(receipt);
        dynamicGeometryHost.publishDynamicGeometry(receipt, worlds, frameRequest?.fixedStep);
        return ok(receipt);
      } catch (cause) {
        internals.observationFrameId = undefined;
        internals.observationCaptureDomains = undefined;
        internals.gpuPassTimingFrameIdentity = undefined;
        const cleanupFailure = disposeOwnedObservationCaptures(observationCaptureOwner.drain());
        if (cleanupFailure !== undefined) return err(cleanupFailure);
        if (cause instanceof CameraViewInvalidError) return err(cause);
        if (cause instanceof ProjectedDecalInvalidError) return err(cause);
        const error =
          cause instanceof Error
            ? { code: 'unknown' as const, message: cause.message, name: cause.name }
            : { code: 'unknown' as const, message: String(cause) };
        const e = new RhiError({
          code: 'webgpu-runtime-error',
          expected:
            'renderSystem.draw(worlds, { cameraOwner, resourceOwner }) completes without throwing',
          hint: `RenderSystem internal error: ${error.message}`,
          detail: { error },
        });
        internals.errorRegistry.fire(e);
        return err(e);
      } finally {
        // Native video pixels have been consumed by synchronous queue copy calls.
        // Release them on every success/failure path, including direct publication users.
        publicationReceiver?.releaseVideoFrames();
      }
    },
    async observe(
      receipt: FrameReceipt,
      request: FrameObservationRequest,
    ): Promise<RenderResult<FrameReceiptObservation, RenderError>> {
      const stale = staleObservationReceipt(receipt);
      if (stale !== undefined) return err(stale);
      const includesDomain = (request.include as readonly string[]).some(isFrameObservationDomain);
      let timingObservation: GpuPassTimingObservation | undefined;
      if (
        includesDomain &&
        gpuPassTimingOptions !== undefined &&
        request.include.includes('timings')
      ) {
        const timingResult =
          timingObservationStore === undefined
            ? await observeGpuPassTimingDisabled(
                receipt,
                request,
                () => activeDeviceScope.generation,
              )
            : await timingObservationStore.observe(receipt, request);
        if (!timingResult.ok) return timingResult;
        timingObservation = timingResult.value.timings;
      }
      if (gpuPassTimingOptions !== undefined && !includesDomain) {
        return timingObservationStore === undefined
          ? observeTiming(receipt, request, () => activeDeviceScope.generation)
          : timingObservationStore.observe(receipt, request);
      }
      const completed = await receipt.completed;
      if (!completed.ok) return completed;
      const staleAfterCompletion = staleObservationReceipt(receipt);
      if (staleAfterCompletion !== undefined) return err(staleAfterCompletion);
      const requestedDomains = (request.include as readonly string[]).filter(
        isFrameObservationDomain,
      );
      let observations: FrameReceiptObservation['observations'];
      if (requestedDomains.length > 0) {
        if (new Set(requestedDomains).size !== requestedDomains.length) {
          return err(
            new RendererContractFailureError(
              'observe',
              'each receipt-bound color domain may be requested only once',
            ),
          );
        }
        const readCaptures = receiptObservationCaptures.get(receipt);
        receiptObservationCaptures.delete(receipt);
        if (readCaptures === undefined) {
          return err(
            new RendererContractFailureError(
              'observe',
              'receipt-bound color-domain observations were not explicitly armed before draw, are stale, duplicated, or unavailable',
            ),
          );
        }
        const capturesResult = await readCaptures();
        const receiptCaptures = receiptObservationBuffers.get(receipt);
        if (receiptCaptures?.every((capture) => destroyedObservationBuffers.has(capture.buffer))) {
          receiptObservationBuffers.delete(receipt);
        }
        if (!capturesResult.ok) return capturesResult;
        const staleAfterReadback = staleObservationReceipt(receipt);
        if (staleAfterReadback !== undefined) return err(staleAfterReadback);
        const projected = projectReceiptColorObservations(
          receipt,
          capturesResult.value,
          requestedDomains,
          internals.device.caps.backendKind,
        );
        if (!projected.ok) return projected;
        observations = projected.value;
      }
      await observeLodOcclusionForReceipt(renderSystem, receipt);
      const targetReadbacks =
        request.targetReadbacks === undefined || request.targetReadbacks.length === 0
          ? undefined
          : await renderTargetHost.observeTargetReadbacks(receipt, request.targetReadbacks);
      if (targetReadbacks !== undefined && !targetReadbacks.ok) return targetReadbacks;
      const volumeTimings = request.include.includes('timings')
        ? await (receiptTimings.get(receipt) ??
            Promise.resolve<VolumeTimingObservation>({
              status: 'unavailable',
              reason: 'timestamp capture was not requested for this frame',
            }))
        : undefined;
      const observation = await observeTiming(receipt, request, () => activeDeviceScope.generation);
      if (!observation.ok) return observation;
      const staleAfterObservation = staleObservationReceipt(receipt);
      if (staleAfterObservation !== undefined) return err(staleAfterObservation);
      return ok(
        Object.freeze({
          ...observation.value,
          ...(targetReadbacks === undefined
            ? {}
            : { targetReadbacks: Object.freeze(targetReadbacks.value) }),
          ...(timingObservation === undefined ? {} : { timings: timingObservation }),
          ...(volumeTimings === undefined ? {} : { volumeTimings }),
          ...(observations === undefined ? {} : { observations }),
        }),
      );
    },
    releaseSurface(): Result<void, RhiError> {
      if (surfaceReleased) return ok(undefined);
      if (disposed) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'live renderer before releasing its surface',
            hint: 'create a new Renderer; disposed renderers are terminal',
          }),
        );
      }
      try {
        internals.context.unconfigure();
        if (pipelineState !== null) pipelineState.perPassResources.configured = false;
        surfaceReleased = true;
        return ok(undefined);
      } catch (cause) {
        return err(wrapDisposeError(cause, 'context.unconfigure'));
      }
    },
    restoreSurface(): Result<void, RhiError> {
      if (!surfaceReleased) return ok(undefined);
      if (disposed) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'live renderer before restoring its surface',
            hint: 'create a new Renderer; disposed renderers are terminal',
          }),
        );
      }
      surfaceReleased = false;
      return ok(undefined);
    },
    /**
     * Release every GPU resource the renderer owns + detach the listener
     * registries; flip the `disposed` latch so subsequent `draw(world)`
     * calls fail-fast with `'rhi-not-available'`.
     *
     * feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5 / w21
     * 6-step cascade (plan-strategy D-2 ordering):
     *   1. `context.unconfigure()`           -- release the current surface image
     *   2. `gpuStore.destroyAll()`           -- texture / cubemap / mesh maps
     *   3. `renderSystem.disposeFrameState()` -- graph.drain() + instanceBuffers
     *   4. `featureHost.dispose()`           -- feature resources + lifecycle
     *   5. DeviceScope retirement -- generation-keyed IBL state becomes stale
     *   6. `lostRegistry.clear() / errorRegistry.clear()`
     *
     * Each step runs inside its own try/catch (D-3 method A): a sub-step
     * failure DOES NOT halt the cascade; the structured RhiError (or wrapped
     * runtime exception) fans out through `errorRegistry.fire` so AI users
     * observing Renderer error events see every dispose-time fault. The
     * `disposed` latch flips up-front so a re-entrant dispose (or a draw
     * that races with the cascade) short-circuits.
     *
     * Raw-device destruction is owned by backend lifetime, not this facade.
     * Browser test isolation handles adapter-pool reuse between tests.
     *
     * Stays in sync with the `Renderer.dispose` row of the README "API index".
     */
    dispose(): RenderResult<void, RenderError> {
      if (disposed) return ok(undefined);
      disposed = true;
      cameraViews.dispose();
      retireGpuPassTimingSession();
      internals.gpuPassTimingCapture = undefined;
      internals.gpuPassTimingSubmittedWork = undefined;
      for (const world of attachedWorlds) dynamicGeometryHost.invalidateDynamicGeometryWorld(world);
      dynamicGeometry.dispose();
      publicationReceiver?.dispose();
      for (const continuation of frameContinuations) {
        continuation.terminate({ code: 'disposed' });
      }
      const cleanupFailures: RendererOperationCause[] = [];
      const observationCleanupFailure = disposeReceiptObservationCaptures();
      if (observationCleanupFailure !== undefined) {
        cleanupFailures.push(observationCleanupFailure);
      }
      for (const world of attachedWorlds) {
        try {
          transformReleases.get(world)?.();
          transformReleases.delete(world);
        } catch (cause) {
          const error = wrapDisposeError(cause, 'world.removeSystem(renderDerived)');
          cleanupFailures.push(error);
          internals.errorRegistry.fire(error);
        }
      }
      attachedWorlds.clear();
      for (const lease of attachedLeases.keys()) {
        try {
          lease.dispose();
        } catch (cause) {
          const error = wrapDisposeError(cause, 'read-lease.dispose');
          cleanupFailures.push(error);
          internals.errorRegistry.fire(error);
        }
      }
      attachedLeases.clear();
      leasesByWorld.clear();
      // Release the current swap-chain image before destroying a resource
      // wrappers that may share its underlying device allocation. The wgpu
      // WebGL2 surface owns an explicit SurfaceTexture; leaving this until
      // after the resource sweep lets wasm drop it against a dead Surface.
      if (!surfaceReleased) {
        try {
          internals.context.unconfigure();
        } catch (cause) {
          const error = wrapDisposeError(cause, 'context.unconfigure');
          cleanupFailures.push(error);
          internals.errorRegistry.fire(error);
        }
      }
      try {
        renderTargetHost.dispose();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'renderTargetHost.dispose');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      // Step 2: release every Buffer / Texture handle owned by the runtime
      // GPU residency layer (feat-20260601-device/gpu-residency-extraction).
      for (const [owner, store] of Object.entries({ dynamicTextureStore, gpuStore })) {
        try {
          store.destroyAll();
        } catch (cause) {
          const error = wrapDisposeError(cause, `${owner}.destroyAll`);
          cleanupFailures.push(error);
          internals.errorRegistry.fire(error);
        }
      }
      // Step 3: drain the per-frame render-graph pool + the per-entity
      // instanceBuffers GPU storage cache. Both walks live on the
      // RenderSystem closure (frameState is closure-private).
      try {
        renderSystem.disposeFrameState();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'renderSystem.disposeFrameState');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      try {
        renderSystem.releaseProfilerCatalog();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'renderSystem.releaseProfilerCatalog');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      // Step 4: release feature-owned resources and invoke feature disposal
      // hooks after render-graph state has been drained. The host is already
      // idempotent, and its structured cleanup detail is preserved by the
      // error registry when a feature cleanup fails.
      try {
        const featureDispose = internals.featureHost?.dispose();
        if (featureDispose !== undefined && !featureDispose.ok) {
          cleanupFailures.push(featureDispose.error);
          internals.errorRegistry.fire(featureDispose.error);
        }
      } catch (cause) {
        const error = wrapDisposeError(cause, 'featureHost.dispose');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      // Retire assembly-owned device resources only after the surface and
      // renderer-owned GPU pools have been released. The wgpu WebGL2 surface
      // still needs a live device while `unconfigure()` presents its pending
      // image; disposing the scope first lets wasm finalizers race that
      // presentation and can surface a parking_lot panic in WebKit.
      try {
        activeDeviceScope.dispose();
      } catch (cause) {
        const error = wrapDisposeError(cause, 'activeDeviceScope.dispose');
        cleanupFailures.push(error);
        internals.errorRegistry.fire(error);
      }
      // Step 5: the IBL cache is keyed by the retired DeviceScope generation.
      // It is no longer reachable through the active renderer scope, while
      // the device teardown owns the child GPU handles.
      // Step 6: detach the listener registries so a post-dispose error
      // event (race with the spec layer) does not fan out to user-supplied
      // listeners (charter P3 explicit failure: post-dispose the renderer
      // is dead, no observable side-effects). Performed last so steps 1-5
      // can still surface failures through `errorRegistry.fire`.
      try {
        internals.lostRegistry.clear();
        internals.errorRegistry.clear();
      } catch (cause) {
        cleanupFailures.push(structuredRendererCause(cause, 'listenerRegistry.clear'));
      }
      return cleanupFailures.length === 0
        ? ok(undefined)
        : err(
            new RendererOperationError('cleanup-failed', {
              operation: 'dispose',
              causes: Object.freeze(cleanupFailures),
            }),
          );
    },
    onError(listener: RendererErrorListener): () => void {
      return internals.errorRegistry.add(listener);
    },
    subscribeHostEvents(listener) {
      const offError = internals.errorRegistry.add((error) => {
        listener(Object.freeze({ kind: 'error', error }));
      });
      const offHealth = internals.healthRegistry.add((health) => {
        listener(Object.freeze({ kind: 'health', health }));
      });
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        offError();
        offHealth();
      };
    },
    onLost(listener: RendererLostListener): () => void {
      return internals.lostRegistry.add(listener);
    },
    health(): HealthSnapshot {
      return internals.healthRegistry.getLastSnapshot();
    },
    recover(): Promise<Result<void, RecoverFailure>> {
      const observationCleanupFailure = disposeReceiptObservationCaptures();
      if (observationCleanupFailure !== undefined) {
        return Promise.resolve(err(new RecoverError('recover-device-unavailable')));
      }
      return recoveryFlight.run();
    },
  };
  /**
   * Publish a fully prepared generation and retire the previous owner set.
   *
   * This is deliberately synchronous: all candidate state is complete before
   * entering the function, and no callback or await is allowed between the
   * active-reference swap and the old-generation retirement. The candidate
   * carries its own shader adapters, pipeline caches, stores, hooks, and
   * post-process handles; a failed build never reaches this boundary.
   */
  const publishAndRetireRendererGeneration = (
    candidate: RendererGeneration,
    candidatePostProcessResources: RecoveryPostProcessResources,
    recoveryRootBundle: RecoveryRootBundle,
    recoveryGraphCandidate: RecoveryGraphCandidate | undefined,
  ): void => {
    if (!candidate.scope.isAlive()) {
      throw new Error('Renderer generation candidate is not publishable.');
    }
    const previous = generationPublication.current;
    const previousBindings = previous?.producerBindings;
    const previousGpuStore = previousBindings?.gpuStore ?? gpuStore;
    const previousDynamicTextureStore =
      previousBindings?.dynamicTextureStore ?? dynamicTextureStore;
    const previousScope = previous?.scope ?? activeDeviceScope;
    // This is the first line of the synchronous publication boundary. The
    // candidate was already compiled and its setup work completed; now shed
    // lost-device RenderSystem owners before installing the candidate state.
    renderSystem.resetForRecover(previous?.pipeline, candidate.device);
    // Candidate readiness is the first point where the target owner may shed
    // old physical handles. Keep its device getter pinned to the old device,
    // but advance its generation so active targets enter their rebuild state;
    // this call is inside the same synchronous publication boundary.
    renderTargetGeneration = candidate.scope.generation;
    renderTargetHost.recover();
    // GPUCanvasContext is canvas-owned rather than generation-owned: the
    // candidate and previous RHI wrappers address the same underlying
    // context. Detach the previous configuration first, then configure the
    // candidate again after that detach. Otherwise the old wrapper's
    // unconfigure() can silently revoke the candidate's configuration while
    // candidate.perPassResources.configured still says true, producing a
    // submitted-but-black recovery frame.
    const previousContext = previous?.context ?? internals.context;
    candidate.pipeline.perPassResources.configured = false;
    previousContext.unconfigure();
    const configured = ensureContextConfigured(
      internals,
      candidate.pipeline,
      internals.errorRegistry,
      candidate.context,
      candidate.device,
    );
    if (!configured.ok) throw configured.error;
    internals.device = candidate.device;
    internals.context = candidate.context;
    publishRendererGeneration(candidate);
    renderTargetDevice = candidate.device;
    // Arm the first-frame guard before any publication code can resolve a
    // fallback pipeline or residency entry. Candidate preparation populated
    // these caches already; a miss here is a hard recovery failure, not an
    // opportunity to hide cold work inside the first visible frame.
    renderSystem.publishRecoveryPostProcessResources(candidatePostProcessResources);
    if (recoveryGraphCandidate !== undefined) {
      renderSystem.publishRecoveryGraphCandidate(recoveryGraphCandidate);
    }
    candidate.pipeline.perPassResources.commitBloomResources?.();
    recoveryRootBundle.publish();
    recoveryGraphCandidate?.markPublished();
    // RenderSystem owns frame/feature GPU state; the generation bindings own
    // residency stores; DeviceScope owns the remaining lifecycle roots. Their
    // retirement is intentionally centralized and ordered after publication.
    previousGpuStore.destroyAll();
    previousDynamicTextureStore.destroyAll();
    previousScope.retire();
  };
  rendererRecovery = createRendererRecovery({
    isDisposed: () => disposed,
    internals,
    getActiveDeviceScope: () => activeDeviceScope,
    getActiveShaderState: () => activeShaderState,
    getMaterialShaderUvSetCounts: () => materialShaderUvSetCounts,
    createRendererPipelineCacheState,
    getCandidateBuildState: () => candidateBuildState,
    setCandidateBuildState(state) {
      candidateBuildState = state;
    },
    getCandidateShaderState: () => candidateShaderState,
    setCandidateShaderState(state) {
      candidateShaderState = state;
    },
    getCandidatePipelineCacheState: () => candidatePipelineCacheState,
    setCandidatePipelineCacheState(state) {
      candidatePipelineCacheState = state;
    },
    getCandidateMaterialShaderUvSetCounts: () => candidateMaterialShaderUvSetCounts,
    setCandidateMaterialShaderUvSetCounts(state) {
      candidateMaterialShaderUvSetCounts = state;
    },
    setCandidateEmptyPostProcessBgl(layout) {
      candidateEmptyPostProcessBgl = layout;
    },
    getShaderModuleAdapter,
    getImmediateShaderModuleAdapter,
    getShader,
    assets,
    adaptMipmapShaderModuleFactory,
    buildPipeline,
    getMaterialShaderPipeline,
    getMaterialShaderPipelineEntry,
    getMaterialShaderArtifact,
    getCachedMaterialShaderBindingContract,
    getParamSchema,
    getMaterialBindGroupLayout,
    metrics,
    buildPostProcessPipeline,
    renderSystem,
    createRecoveryFailureLocation,
    publishAndRetireRendererGeneration,
  });
  return renderer;
}
