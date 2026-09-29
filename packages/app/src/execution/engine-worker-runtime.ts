import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import { type AudioIntent, createAudioIntentBackend } from '@forgeax/engine-audio';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { SharedKernelExecutor } from '@forgeax/engine-ecs/shared';
import {
  type CompositeInputLease,
  type InputBackend,
  type InputBackendSample,
  makeCompositeBackend,
} from '@forgeax/engine-input';
import { type Context, Inject, type Plugin } from '@forgeax/engine-plugin';
import {
  createProfiler,
  type ProfileFrameToken,
  type Profiler,
  type RecorderSession,
} from '@forgeax/engine-profiler';
import {
  type Renderer,
  RenderPublicationError,
  RenderPublicationTargetOwner,
} from '@forgeax/engine-render';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import {
  constructRuntimeRendererHost,
  createPublicationAssets,
} from '@forgeax/engine-runtime/internal/renderer-host';
import { createAnimationPayloadLookup } from '../animation-asset-lookup';
import { type AssetRuntimeAssembly, createAssetRuntimeAssembly } from '../assets-runtime-assembly';
import { syncCameraAspect } from '../canvas-policy';
import { createCanonicalEcsImportModule } from '../internal/ecs-import';
import {
  createRhiCapture,
  createRhiInstrumentation,
  type RhiCapture,
} from '../internal/rhi-capture';
import { workerEngineProfile } from '../internal/worker-engine-profile';
import { attachWorkerRhiRecorder } from '../internal/worker-rhi-capture';
import { type AppObservation, createAppObservation } from '../observation';
import { createRenderFeatureHost } from '../renderer-plugin';
import { APP_PHASE_CATALOG } from '../types';
import { commitAttachedWorld, SerializedRebuildQueue } from './attached-world-swap';
import {
  activateExecutionRoot,
  executionBootstrapHostPlugin,
  type PreparedExecutionBootstrap,
  prepareBootstrapEntry,
} from './bootstrap-entry';
import { createKernelPool, type KernelPool } from './kernel-pool';
import type {
  EngineToHostMessage,
  ExecutionFrameMessage,
  ExecutionInitMessage,
  ExecutionInspectMessage,
  ExecutionRebuildMessage,
  HostToEngineMessage,
} from './protocol';
import { SourceRenderWorker } from './source-render-worker';
import { serializableDetail } from './worker-error';

const scope = globalThis as unknown as {
  postMessage(message: EngineToHostMessage): void;
  onmessage: ((event: MessageEvent<HostToEngineMessage>) => void) | null;
  close(): void;
};

let renderer: Renderer | undefined;
let assets: import('@forgeax/engine-assets-runtime').AssetRegistry | undefined;
let currentSample: InputBackendSample = {
  downKeys: new Set(),
  upKeys: new Set(),
  buttons: [false, false, false],
  movementX: 0,
  movementY: 0,
  wheelDelta: 0,
  focused: true,
  pointerLocked: false,
};
let lastFrameId = 0;
let renderSampleTimeSeconds = 0;
let engineCanvas: OffscreenCanvas | undefined;
interface WorkerRealm {
  readonly world: World;
  renderWorker?: SourceRenderWorker;
  publicationTargets?: RenderPublicationTargetOwner;
  readonly init: ExecutionInitMessage;
  assetAssembly: AssetRuntimeAssembly | undefined;
  pendingAudioIntents: AudioIntent[];
  kernelPool: KernelPool | undefined;
  pluginContext: Context | undefined;
  observation: AppObservation | undefined;
  profiler: Profiler | undefined;
  releaseProfilerCatalog: (() => void) | undefined;
  rhiCapture: RhiCapture | undefined;
  rhiAttachment: RecorderAttachment | undefined;
  profilerCaptureId: string | undefined;
  profilerFrameId: number;
}

let realm: WorkerRealm | undefined;
const rebuildQueue = new SerializedRebuildQueue();
const inspectionQueue: ExecutionInspectMessage[] = [];
/** Requests that passed the frame-boundary admission point and may still run. */
const activeInspectionIds = new Set<number>();

type WorkerExecuteModule = {
  readonly executeScript: (
    script: string,
    context: {
      readonly world: unknown;
      readonly renderer: unknown;
      readonly assets: unknown;
      readonly rhiCapture?: unknown;
      readonly profiler?: unknown;
      readonly simulation: unknown;
      readonly execution: unknown;
      readonly importModule?: (specifier: string) => Promise<unknown>;
    },
  ) => Promise<
    { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }
  >;
};

let executeScriptPromise: Promise<WorkerExecuteModule> | undefined;

function serializableEvalError(error: unknown): { readonly code: string; readonly hint: string } {
  if (error !== null && typeof error === 'object') {
    const candidate = error as { readonly code?: unknown; readonly message?: unknown };
    return {
      code: typeof candidate.code === 'string' ? candidate.code : 'worker-eval-error',
      hint: typeof candidate.message === 'string' ? candidate.message : String(error),
    };
  }
  return { code: 'worker-eval-error', hint: String(error) };
}

function profilePhase<T>(session: RecorderSession | undefined, phase: string, action: () => T): T {
  const opened = session?.beginPhase('app', phase).ok ?? false;
  try {
    return action();
  } finally {
    if (opened) {
      try {
        session?.endPhase();
      } catch {
        // Profiling is observational and never changes frame ownership.
      }
    }
  }
}

async function executeInspection(job: ExecutionInspectMessage, target: WorkerRealm): Promise<void> {
  if (job.worldIdentity !== target.world.identity) {
    scope.postMessage({
      kind: 'inspect-result',
      requestId: job.requestId,
      worldIdentity: target.world.identity,
      result: {
        ok: false,
        error: {
          code: 'live-world-stale',
          hint: 'The inspection belongs to an older World; fetch status and retry.',
          detail: { expected: job.worldIdentity, actual: target.world.identity },
        },
      },
    });
    return;
  }
  activeInspectionIds.add(job.requestId);
  let inputLease: CompositeInputLease | undefined;
  try {
    // The queue is admitted only from runFrame. This is the authoritative
    // start witness consumed by the browser relay for cancellation semantics.
    scope.postMessage({
      kind: 'inspect-started',
      requestId: job.requestId,
      worldIdentity: target.world.identity,
    });
    executeScriptPromise ??= import('@forgeax/engine-remote/execute').then(
      (module) => module as unknown as WorkerExecuteModule,
    );
    const module = await executeScriptPromise;
    const importModule = createCanonicalEcsImportModule(target.world, async (specifier: string) => {
      // A Worker cannot resolve a bare package specifier from the browser
      // document. Vite's dev module endpoint is the same resolver used by the
      // main-realm bridge; canonicalize component exports back to this
      // Worker-owned World's catalog before returning them to eval.
      const browserSpecifier = specifier.startsWith('@') ? `/@id/${specifier}` : specifier;
      return import(/* @vite-ignore */ browserSpecifier);
    });
    inputLease = inputBackend.createInjectedLease();
    const simulation = {
      pluginContext: target.pluginContext,
      world: target.world,
      renderer,
      assets,
      input: inputLease,
      rhiCapture: target.rhiCapture,
      profiler: target.profiler,
      execution: {
        report: () => ({
          workers: target.init.workers,
          engine: { realm: 'worker' },
          world: { identity: target.world.identity },
        }),
        gpuPassTiming: () => target.renderWorker?.inspectGpuPassTiming(),
      },
    };
    target.observation ??= createAppObservation(
      target.world,
      renderer ?? {
        bounds: (_world, entity) => {
          if (target.renderWorker === undefined) throw new Error('Render Worker session ended');
          return target.renderWorker.bounds(entity);
        },
      },
      simulation.execution,
    );
    const observation = target.observation;
    const result = await module.executeScript(job.code, {
      world: target.world,
      renderer,
      assets,
      simulation: { ...simulation, observation },
      rhiCapture: target.rhiCapture,
      profiler: target.profiler,
      execution: simulation.execution,
      importModule,
    });
    scope.postMessage({
      kind: 'inspect-result',
      requestId: job.requestId,
      worldIdentity: target.world.identity,
      result,
    });
  } catch (error) {
    scope.postMessage({
      kind: 'inspect-result',
      requestId: job.requestId,
      worldIdentity: target.world.identity,
      result: { ok: false, error: serializableEvalError(error) },
    });
  } finally {
    // The lease is lexical to this admitted execution. A later job may already
    // own the backend; the lease's generation fence makes this revoke a no-op
    // in that case, so an old async script cannot clear newer input.
    inputLease?.revokeInjectedLease();
    activeInspectionIds.delete(job.requestId);
  }
}

const inputBackendBase: InputBackend = {
  sample: () => currentSample,
  detach: () => {},
};
const inputBackend = makeCompositeBackend(inputBackendBase);

function sharedKernelPlugin(target: WorkerRealm): Plugin {
  return {
    name: 'shared-kernel-executor',
    inject: ['world'],
    apply(ctx) {
      const executor: SharedKernelExecutor = {
        warmup(kernel) {
          target.kernelPool ??= createKernelPool();
          target.kernelPool.warmup?.(kernel);
        },
        execute(kernel, spans) {
          target.kernelPool ??= createKernelPool();
          return target.kernelPool.execute(kernel, spans);
        },
      };
      ctx.effect(() => {
        ctx.world.insertResource('SharedKernelExecutor', executor);
        return () => {
          ctx.world.removeResource('SharedKernelExecutor');
          target.kernelPool?.dispose();
          target.kernelPool = undefined;
        };
      }, 'execution/shared-kernel');
    },
  };
}

function postFault(
  source: 'bootstrap' | 'runtime' | 'world' | 'rebuild',
  code: string,
  expected: string,
  hint: string,
  cause: unknown,
  partialWrite = false,
): void {
  scope.postMessage({
    kind: 'fault',
    worldIdentity: realm?.world.identity ?? null,
    source,
    code,
    expected,
    hint,
    detail: serializableDetail(cause),
    partialWrite,
    retryable: false,
  });
}

async function disposeRealm(target: WorkerRealm): Promise<void> {
  let renderFailure: unknown;
  try {
    await target.renderWorker?.dispose();
  } catch (cause) {
    renderFailure = cause;
  }
  target.observation?.release();
  target.observation = undefined;
  try {
    target.profiler?.activeSession()?.finish();
  } catch {
    // Diagnostics never turn realm disposal into a second failure.
  }
  target.releaseProfilerCatalog?.();
  target.releaseProfilerCatalog = undefined;
  try {
    await target.pluginContext?.fiber.dispose();
  } finally {
    target.pluginContext = undefined;
    target.publicationTargets?.dispose();
    target.assetAssembly?.dispose();
    target.assetAssembly = undefined;
    await target.rhiAttachment?.dispose();
    target.rhiAttachment = undefined;
    target.rhiCapture = undefined;
    target.pendingAudioIntents = [];
  }
  if (renderFailure !== undefined) throw renderFailure;
}

function postBootstrapFault(error: {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: unknown;
}): void {
  postFault('bootstrap', error.code, error.expected, error.hint, error.detail);
}

async function createRealm(init: ExecutionInitMessage): Promise<boolean> {
  const preparedResult = await prepareBootstrapEntry(init.bootstrapUrl, init.bootstrapData);
  if (!preparedResult.ok) {
    postBootstrapFault(preparedResult.error);
    return false;
  }
  const prepared: PreparedExecutionBootstrap = preparedResult.value;
  const sourceFeatures = [...(prepared.features ?? [])];
  const nextWorld = new World({
    ...(init.time !== undefined ? { time: init.time } : {}),
    storage: init.workers.kernels.enabled ? 'shared' : 'local',
  });
  const profiler = init.diagnostics?.profiler === true ? createProfiler() : undefined;
  const profilerCatalog = profiler?.registerPhaseCatalog('app', APP_PHASE_CATALOG);
  const candidate: WorkerRealm = {
    world: nextWorld,
    init,
    assetAssembly: undefined,
    pendingAudioIntents: [],
    kernelPool: undefined,
    pluginContext: undefined,
    observation: undefined,
    profiler,
    releaseProfilerCatalog: profilerCatalog?.ok === true ? profilerCatalog.value : undefined,
    rhiCapture: undefined,
    rhiAttachment: undefined,
    profilerCaptureId: undefined,
    profilerFrameId: 0,
  };
  const audioBackend = createAudioIntentBackend({
    emit: (intent) => candidate.pendingAudioIntents.push(intent),
  });
  let candidateRenderer: Renderer | undefined;
  let rendererLifecycleTransferred = false;
  let rhiLifecycleTransferred = false;
  const previousRenderer = renderer;
  let previousSurfaceReleased = false;
  try {
    if (previousRenderer !== undefined) {
      const released = previousRenderer.releaseSurface();
      if (!released.ok) throw released.error;
      previousSurfaceReleased = true;
    }
    const runtimeBinding = init.assetCatalog?.runtimeBinding;
    const bundler =
      init.shaderManifestUrl === undefined &&
      init.build === undefined &&
      runtimeBinding === undefined
        ? undefined
        : {
            ...(init.shaderManifestUrl === undefined
              ? {}
              : { shaderManifestUrl: init.shaderManifestUrl }),
            ...(init.build === undefined ? {} : { build: init.build }),
            ...(runtimeBinding === undefined
              ? {}
              : { importTransport: createDevImportTransport(runtimeBinding) }),
          };
    const rendererOptions: import('@forgeax/engine-render').RendererOptions = {
      ...(prepared.features === undefined ? {} : { features: prepared.features }),
      ...(profiler === undefined ? {} : { profiler }),
      ...(init.diagnostics?.gpuPassTiming === undefined
        ? {}
        : { gpuPassTiming: init.diagnostics.gpuPassTiming }),
    };
    if (init.diagnostics?.rhiCapture === true && !init.workers.render.enabled) {
      const attachment = await attachWorkerRhiRecorder();
      candidate.rhiAttachment = attachment;
      candidate.rhiCapture = createRhiCapture(attachment);
      Object.assign(rendererOptions, {
        rhi: attachment.backend.rhi,
        rhiInstrumentation: createRhiInstrumentation(attachment),
      });
    }
    const split = init.workers.render.enabled;
    if (split) candidate.publicationTargets = new RenderPublicationTargetOwner();
    if (split) {
      for (const plugin of prepared.plugins ?? []) {
        if ('renderer' in Inject.resolve(plugin.inject))
          throw new RenderPublicationError({
            reason: 'unsupported',
            subject: `source plugin ${plugin.name ?? 'anonymous'} requires the child Renderer`,
          });
      }
    }
    const constructed = split
      ? undefined
      : await constructRuntimeRendererHost(init.canvas, rendererOptions, bundler);
    if (constructed !== undefined && !constructed.ok) throw constructed.error;
    const host = constructed?.ok === true ? constructed.value : undefined;
    candidateRenderer = host?.renderer;
    if (candidateRenderer !== undefined) await prepared.configureRenderer?.(candidateRenderer);
    assets = host?.assets ?? (await createPublicationAssets(bundler));
    const catalogSource =
      init.assetCatalog === undefined
        ? undefined
        : createCatalogSource({
            url: init.assetCatalog.url,
            ...(init.assetCatalog.expectedScope === undefined
              ? {}
              : { expectedScope: init.assetCatalog.expectedScope }),
          });
    const assetAssemblyResult = createAssetRuntimeAssembly(assets, {
      ...(catalogSource === undefined ? {} : { catalogSource }),
      ...(runtimeBinding === undefined ? {} : { runtimeBinding }),
    });
    if (!assetAssemblyResult.ok) throw assetAssemblyResult.error;
    candidate.assetAssembly = assetAssemblyResult.value;
    rendererLifecycleTransferred = true;
    const renderTargets = candidate.publicationTargets?.authoring ?? candidateRenderer;
    const pluginContext = await createWorldContext(
      nextWorld,
      workerEngineProfile({
        ...(candidateRenderer === undefined ? {} : { renderer: candidateRenderer }),
        rendererFeatureHost:
          host === undefined
            ? {
                async installFeature(feature) {
                  if (prepared.features?.includes(feature)) {
                    if (!sourceFeatures.includes(feature)) sourceFeatures.push(feature);
                    let released = false;
                    return {
                      ok: true,
                      value: {
                        async release() {
                          if (!released) {
                            released = true;
                            const index = sourceFeatures.indexOf(feature);
                            if (index >= 0) sourceFeatures.splice(index, 1);
                          }
                          return { ok: true, value: undefined };
                        },
                      },
                    };
                  }
                  return {
                    ok: false,
                    error: new RenderPublicationError({
                      reason: 'unsupported',
                      subject: `RenderFeature ${feature.identity}`,
                    }),
                  };
                },
              }
            : createRenderFeatureHost(host.featureHost),
        assets,
        input: inputBackend,
        audio: audioBackend,
        assetAssembly: assetAssemblyResult.value,
        ...(prepared.pluginPrograms === undefined
          ? {}
          : { pluginPrograms: prepared.pluginPrograms }),
        ...(prepared.runtimePacks === undefined ? {} : { runtimePacks: prepared.runtimePacks }),
        animationPayloads: createAnimationPayloadLookup(assetAssemblyResult.value.registry),
        extensions: [
          ...(init.workers.kernels.enabled ? [sharedKernelPlugin(candidate)] : []),
          executionBootstrapHostPlugin({
            ...(renderTargets === undefined ? {} : { renderTargets }),
            ...(split ? {} : { canvas: init.canvas }),
            ...(init.bootstrapPort === undefined ? {} : { port: init.bootstrapPort }),
            setPointerLockAllowed(allowed): void {
              scope.postMessage({
                kind: 'host-control',
                command: 'set-pointer-lock-allowed',
                allowed,
              });
            },
          }),
          ...(prepared.plugins ?? []),
        ],
      }),
    );
    candidate.pluginContext = pluginContext;
    if (prepared.root) await activateExecutionRoot(pluginContext, prepared.root);
    const activeRenderer = candidateRenderer;
    const previousRealm = realm;
    await candidate.kernelPool?.ready();
    const committed =
      candidateRenderer === undefined
        ? true
        : await commitAttachedWorld(candidateRenderer, nextWorld, async () => true);
    if (!committed) {
      await disposeRealm(candidate);
      if (previousSurfaceReleased) previousRenderer?.restoreSurface();
      return false;
    }
    // A successful World replacement is a lease boundary too. Revoke only
    // after the candidate is committed so a failed rebuild cannot clear input
    // still owned by the live previous World; the generation fence then makes
    // every old async inspection handle permanently read-only.
    if (split) {
      candidate.renderWorker = new SourceRenderWorker(
        nextWorld,
        assets,
        init,
        (message) => scope.postMessage(message),
        sourceFeatures,
        candidate.publicationTargets,
      );
      await candidate.renderWorker.start(init.canvas);
      if (init.diagnostics?.rhiCapture === true) candidate.rhiCapture = candidate.renderWorker;
      engineCanvas = undefined;
    }
    inputBackend.revokeInjectedLease();
    realm = candidate;
    renderer = activeRenderer;
    rhiLifecycleTransferred = candidate.rhiAttachment !== undefined;
    lastFrameId = 0;
    renderSampleTimeSeconds = 0;
    if (previousRealm !== undefined) await disposeRealm(previousRealm);
    return true;
  } catch (cause) {
    await disposeRealm(candidate);
    if (!rendererLifecycleTransferred) candidateRenderer?.dispose();
    if (!rhiLifecycleTransferred) candidate.rhiAttachment = undefined;
    if (previousSurfaceReleased) previousRenderer?.restoreSurface();
    throw cause;
  }
}

async function initialize(message: ExecutionInitMessage): Promise<void> {
  try {
    engineCanvas = message.canvas;
    if (!(await createRealm(message))) return;
    scope.postMessage({
      kind: 'ready',
      worldIdentity: realm?.world.identity ?? '',
      realm: 'worker',
      workerWebGpu: typeof navigator === 'object' && navigator.gpu !== undefined,
    });
  } catch (cause) {
    postFault(
      'bootstrap',
      'app-execution-bootstrap-failed',
      'Engine Worker creates a realm-local World, Renderer and GPU owner',
      'inspect the worker bootstrap cause and module URL',
      cause,
    );
  }
}

async function runFrame(message: ExecutionFrameMessage): Promise<void> {
  const activeRealm = realm;
  const activeRenderer = renderer;
  if (
    activeRealm === undefined ||
    (activeRenderer === undefined && activeRealm.renderWorker === undefined)
  )
    return;
  const { world } = activeRealm;
  if (message.worldIdentity !== world.identity || message.frameId <= lastFrameId) return;
  if (activeRenderer !== undefined && activeRenderer.state() !== 'alive') return;
  if (activeRealm.renderWorker !== undefined && !(await activeRealm.renderWorker.waitUntilReady()))
    return;
  if (realm !== activeRealm) return;
  currentSample = message.inputSample;
  const sampleTimeSeconds =
    message.sampleTimeSeconds === undefined
      ? renderSampleTimeSeconds + message.deltaSeconds
      : message.sampleTimeSeconds;
  const canvasWidth =
    Number.isFinite(message.canvasWidth) && message.canvasWidth > 0
      ? Math.max(1, Math.floor(message.canvasWidth))
      : undefined;
  const canvasHeight =
    Number.isFinite(message.canvasHeight) && message.canvasHeight > 0
      ? Math.max(1, Math.floor(message.canvasHeight))
      : undefined;
  if (canvasWidth !== undefined && canvasHeight !== undefined) {
    if (engineCanvas !== undefined) {
      if (engineCanvas.width !== canvasWidth) engineCanvas.width = canvasWidth;
      if (engineCanvas.height !== canvasHeight) engineCanvas.height = canvasHeight;
    }
    syncCameraAspect(world, canvasWidth, canvasHeight);
  }
  const inspections = inspectionQueue.splice(0, inspectionQueue.length);
  // Admission happens at a frame boundary, but the async script must not hold
  // the Worker frame credit open while it awaits. The DevKit owner tracks the
  // same promise and blocks conflicting observation writes until it completes.
  for (const inspection of inspections) void executeInspection(inspection, activeRealm);
  const started = performance.now();
  const profileSession = activeRealm.profiler?.activeSession();
  let profileFrame: ProfileFrameToken | undefined;
  if (profileSession !== undefined) {
    if (activeRealm.profilerCaptureId !== profileSession.captureId) {
      activeRealm.profilerCaptureId = profileSession.captureId;
      activeRealm.profilerFrameId = 0;
    }
    const frame = profileSession.beginFrame(++activeRealm.profilerFrameId);
    if (frame.ok) {
      profileFrame = {
        captureId: profileSession.captureId,
        frameId: activeRealm.profilerFrameId,
      };
    }
  }
  try {
    const update = profilePhase(profileSession, 'world-update-primary', () =>
      world.update(message.deltaSeconds),
    );
    if (!update.ok) throw update.error;
    if (world.execution.health === 'poisoned') {
      const fault = world.execution.fault;
      postFault(
        'world',
        fault?.code ?? 'world-poisoned',
        'World remains healthy through update',
        'rebuild the poisoned World explicitly',
        fault,
        fault?.partialWrite ?? true,
      );
      return;
    }
    const updateFinished = performance.now();
    const kernelDispatch = activeRealm.kernelPool?.takeLastDispatch() ?? null;
    const kernelMetrics =
      kernelDispatch === null
        ? {}
        : {
            kernelDispatch: {
              eligible: true,
              usedShared: kernelDispatch.mode === 'shared',
              reason:
                kernelDispatch.mode === 'shared' ? ('shared' as const) : ('forced-inline' as const),
              dispatched: kernelDispatch.dispatched,
              completed: kernelDispatch.completed,
            },
          };
    activeRealm.observation?.prepareFrame();
    if (activeRealm.renderWorker !== undefined) {
      activeRealm.renderWorker.publish(message, sampleTimeSeconds);
      renderSampleTimeSeconds = sampleTimeSeconds;
      lastFrameId = message.frameId;
      const audioIntents = activeRealm.pendingAudioIntents;
      activeRealm.pendingAudioIntents = [];
      scope.postMessage({
        kind: 'simulation-complete',
        worldIdentity: world.identity,
        frameId: message.frameId,
        engineUpdateMs: updateFinished - started,
        kernelWaitMs: kernelDispatch?.waitMs ?? 0,
        ...kernelMetrics,
        ...(audioIntents.length ? { audioIntents } : {}),
      });
      return;
    }
    if (activeRenderer === undefined) return;
    const attached = activeRenderer.attach(world);
    if (!attached.ok) throw attached.error;
    const draw = profilePhase(profileSession, 'renderer-draw', () =>
      activeRenderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
        sampleTimeSeconds,
        ...(message.temporalReset ? { temporalReset: true } : {}),
        ...(profileFrame === undefined ? {} : { profileFrame }),
      }),
    );
    if (!draw.ok) throw draw.error;
    // Publish the fallback worker clock only after the renderer accepted this
    // frame. A rejected submit must leave the temporal sample pair and the
    // next implicit timestamp unchanged.
    if (Number.isFinite(sampleTimeSeconds)) renderSampleTimeSeconds = sampleTimeSeconds;
    scope.postMessage({
      kind: 'frame-submitted',
      worldIdentity: world.identity,
      frameId: message.frameId,
      deviceGeneration: draw.value.deviceGeneration,
      ...(draw.value.graphGeneration === undefined
        ? {}
        : { graphGeneration: draw.value.graphGeneration }),
      ...(draw.value.barrelDistortion === undefined
        ? {}
        : { barrelDistortion: draw.value.barrelDistortion }),
    });
    const completed = await draw.value.completed;
    if (!completed.ok) throw completed.error;
    lastFrameId = message.frameId;
    const audioIntents = activeRealm.pendingAudioIntents;
    activeRealm.pendingAudioIntents = [];
    scope.postMessage({
      kind: 'frame-complete',
      worldIdentity: world.identity,
      frameId: message.frameId,
      deviceGeneration: draw.value.deviceGeneration,
      ...(draw.value.graphGeneration === undefined
        ? {}
        : { graphGeneration: draw.value.graphGeneration }),
      ...(draw.value.barrelDistortion === undefined
        ? {}
        : { barrelDistortion: draw.value.barrelDistortion }),
      presentation: draw.value.presentation,
      engineUpdateMs: updateFinished - started,
      kernelWaitMs: kernelDispatch?.waitMs ?? 0,
      ...(audioIntents.length > 0 ? { audioIntents } : {}),
      ...kernelMetrics,
    });
  } catch (cause) {
    const fault = world.execution.fault;
    postFault(
      fault === null ? 'runtime' : 'world',
      fault?.code ?? 'app-system-update-failed',
      'World update completes before Renderer draw',
      fault === null ? 'inspect the runtime cause' : 'rebuild the poisoned World explicitly',
      cause,
      fault?.partialWrite ?? false,
    );
  } finally {
    if (profileFrame !== undefined) {
      try {
        profileSession?.endFrame();
      } catch {
        // Profiling is observational and never changes Worker frame ownership.
      }
    }
  }
}

async function rebuild(message: ExecutionRebuildMessage): Promise<void> {
  const activeRealm = realm;
  if (
    activeRealm === undefined ||
    (renderer === undefined && activeRealm.renderWorker === undefined) ||
    message.worldIdentity !== activeRealm.world.identity
  )
    return;
  const previousWorldIdentity = activeRealm.world.identity;
  try {
    const cancelled = inspectionQueue.splice(0, inspectionQueue.length);
    for (const job of cancelled) {
      scope.postMessage({
        kind: 'inspect-result',
        requestId: job.requestId,
        worldIdentity: previousWorldIdentity,
        result: {
          ok: false,
          error: {
            code: 'live-world-stale',
            hint: 'The World was rebuilt before inspection admission.',
            detail: { worldIdentity: previousWorldIdentity },
          },
        },
      });
    }
    const canvas = message.canvas ?? engineCanvas;
    if (canvas === undefined) throw new Error('World rebuild requires a fresh rendering canvas');
    await activeRealm.renderWorker?.dispose();
    const init: ExecutionInitMessage = { ...activeRealm.init, canvas };
    if (!(await createRealm(init))) return;
    scope.postMessage({
      kind: 'rebuilt',
      previousWorldIdentity,
      worldIdentity: realm?.world.identity ?? '',
    });
  } catch (cause) {
    postFault(
      'rebuild',
      'app-execution-rebuild-failed',
      'bootstrap creates a fresh World identity',
      'inspect the bootstrap cause or create a new App',
      cause,
    );
  }
}

scope.onmessage = (event): void => {
  const message = event.data;
  if (message.kind === 'render-replace') {
    void realm?.renderWorker
      ?.replace(message.epoch, message.canvas)
      .catch((cause) =>
        postFault(
          'runtime',
          'render-worker-recovery-failed',
          'replacement Renderer starts',
          'inspect replacement failure',
          cause,
        ),
      );
  } else if (message.kind === 'init') void initialize(message);
  else if (message.kind === 'frame') void runFrame(message);
  else if (message.kind === 'inspect') inspectionQueue.push(message);
  else if (message.kind === 'inspect-cancel') {
    const index = inspectionQueue.findIndex((job) => job.requestId === message.requestId);
    if (index >= 0) {
      const [cancelled] = inspectionQueue.splice(index, 1);
      if (cancelled !== undefined) {
        scope.postMessage({
          kind: 'inspect-canceled',
          requestId: cancelled.requestId,
          worldIdentity: realm?.world.identity ?? cancelled.worldIdentity,
          admitted: false,
        });
      }
    } else {
      // A request absent from the queue has either started or already posted
      // its terminal result. Keep the caller attached to that execution rather
      // than falsely claiming it was cancelled before admission.
      scope.postMessage({
        kind: 'inspect-canceled',
        requestId: message.requestId,
        worldIdentity: realm?.world.identity ?? message.worldIdentity,
        admitted: true,
      });
    }
  } else if (message.kind === 'rebuild') {
    void rebuildQueue.enqueue(() => rebuild(message));
  } else if (message.kind === 'dispose') {
    void (async () => {
      const target = realm;
      realm = undefined;
      inspectionQueue.length = 0;
      try {
        if (target !== undefined) await disposeRealm(target);
        scope.postMessage({ kind: 'disposed' });
      } catch (cause) {
        scope.postMessage({ kind: 'disposed', error: serializableDetail(cause) });
      } finally {
        target?.init.bootstrapPort?.close();
        scope.close();
      }
    })();
  } else if (message.kind === 'input-clear') {
    inputBackend.revokeInjectedLease();
  } else if (message.kind === 'input-lease-open') {
    inputBackend.beginInjectedLease();
  } else if (message.kind === 'profile-finish') {
    try {
      const current = realm;
      const active = current?.profiler?.activeSession();
      if (
        active !== undefined &&
        (message.worldIdentity === undefined ||
          current?.world.identity === message.worldIdentity) &&
        (message.captureId === undefined || active.captureId === message.captureId)
      ) {
        active.finish();
      }
    } catch {
      // Diagnostic cleanup is best effort and never changes the Worker state.
    }
  }
};
