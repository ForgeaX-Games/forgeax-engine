import { type AudioIntent, createAudioIntentBackend } from '@forgeax/engine-audio';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { SharedKernelExecutor } from '@forgeax/engine-ecs/shared';
import type { InputBackend, InputBackendSample } from '@forgeax/engine-input';
import type { Context, Plugin } from '@forgeax/engine-plugin';
import type { Renderer } from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { createAnimationPayloadLookup } from '../animation-asset-lookup';
import { syncCameraAspect } from '../canvas-policy';
import { workerEngineProfile } from '../internal/worker-engine-profile';
import { createRenderFeatureHost } from '../renderer-plugin';
import { commitAttachedWorld, SerializedRebuildQueue } from './attached-world-swap';
import {
  executionBootstrapHostPlugin,
  type PreparedExecutionBootstrap,
  prepareBootstrapEntry,
} from './bootstrap-entry';
import { createKernelPool, type KernelPool } from './kernel-pool';
import type {
  EngineToHostMessage,
  ExecutionFrameMessage,
  ExecutionInitMessage,
  ExecutionRebuildMessage,
  HostToEngineMessage,
} from './protocol';

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
let engineCanvas: OffscreenCanvas | undefined;
interface WorkerRealm {
  readonly world: World;
  readonly init: ExecutionInitMessage;
  pendingAudioIntents: AudioIntent[];
  kernelPool: KernelPool | undefined;
  pluginContext: Context | undefined;
}

let realm: WorkerRealm | undefined;
const rebuildQueue = new SerializedRebuildQueue();

const inputBackend: InputBackend = {
  sample: () => currentSample,
  detach: () => {},
};

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

function serializableCause(cause: unknown): { readonly name: string; readonly message: string } {
  return cause instanceof Error
    ? { name: cause.name, message: cause.message }
    : { name: 'Error', message: String(cause) };
}

function serializableDetail(cause: unknown): unknown {
  if (cause instanceof Error) return serializableCause(cause);
  if (Array.isArray(cause)) return cause.map(serializableDetail);
  if (typeof cause === 'object' && cause !== null) {
    return Object.fromEntries(
      Object.entries(cause).map(([key, value]) => [key, serializableDetail(value)]),
    );
  }
  return cause;
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
  await target.pluginContext?.fiber.dispose();
  target.pluginContext = undefined;
  target.pendingAudioIntents = [];
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
  const nextWorld = new World({
    ...(init.time !== undefined ? { time: init.time } : {}),
    storage: init.tier === 'shared' ? 'shared' : 'local',
  });
  const candidate: WorkerRealm = {
    world: nextWorld,
    init,
    pendingAudioIntents: [],
    kernelPool: undefined,
    pluginContext: undefined,
  };
  const audioBackend = createAudioIntentBackend({
    emit: (intent) => candidate.pendingAudioIntents.push(intent),
  });
  let candidateRenderer: Renderer | undefined;
  let rendererLifecycleTransferred = false;
  const previousRenderer = renderer;
  let previousSurfaceReleased = false;
  try {
    if (previousRenderer !== undefined) {
      const released = previousRenderer.releaseSurface();
      if (!released.ok) throw released.error;
      previousSurfaceReleased = true;
    }
    const constructed = await constructRuntimeRendererHost(
      init.canvas,
      prepared.features === undefined ? {} : { features: prepared.features },
      init.shaderManifestUrl === undefined
        ? undefined
        : { shaderManifestUrl: init.shaderManifestUrl },
    );
    if (!constructed.ok) throw constructed.error;
    candidateRenderer = constructed.value.renderer;
    assets = constructed.value.assets;
    rendererLifecycleTransferred = true;
    const pluginContext = await createWorldContext(
      nextWorld,
      workerEngineProfile({
        renderer: candidateRenderer,
        rendererFeatureHost: createRenderFeatureHost(constructed.value.featureHost),
        assets,
        input: inputBackend,
        audio: audioBackend,
        animationPayloads: createAnimationPayloadLookup(assets),
        extensions: [
          ...(init.tier === 'shared' ? [sharedKernelPlugin(candidate)] : []),
          executionBootstrapHostPlugin({
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
    const activeRenderer = candidateRenderer;
    const previousRealm = realm;
    const committed = await commitAttachedWorld(candidateRenderer, nextWorld, async () => {
      await candidate.kernelPool?.ready();
      return true;
    });
    if (!committed) {
      await disposeRealm(candidate);
      if (previousSurfaceReleased) previousRenderer?.restoreSurface();
      return false;
    }
    realm = candidate;
    renderer = activeRenderer;
    lastFrameId = 0;
    if (previousRealm !== undefined) await disposeRealm(previousRealm);
    return true;
  } catch (cause) {
    await disposeRealm(candidate);
    if (!rendererLifecycleTransferred) candidateRenderer?.dispose();
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

function runFrame(message: ExecutionFrameMessage): void {
  const activeRealm = realm;
  if (activeRealm === undefined || renderer === undefined) return;
  const { world } = activeRealm;
  if (message.worldIdentity !== world.identity || message.frameId <= lastFrameId) return;
  currentSample = message.inputSample;
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
  const started = performance.now();
  try {
    const update = world.update(message.deltaSeconds);
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
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const draw = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    if (!draw.ok) throw draw.error;
    lastFrameId = message.frameId;
    const kernelDispatch = activeRealm.kernelPool?.takeLastDispatch() ?? null;
    const audioIntents = activeRealm.pendingAudioIntents;
    activeRealm.pendingAudioIntents = [];
    scope.postMessage({
      kind: 'frame-complete',
      worldIdentity: world.identity,
      frameId: message.frameId,
      engineUpdateMs: updateFinished - started,
      kernelWaitMs: kernelDispatch?.waitMs ?? 0,
      ...(audioIntents.length > 0 ? { audioIntents } : {}),
      ...(kernelDispatch !== null
        ? {
            kernelDispatch: {
              eligible: true,
              usedShared: kernelDispatch.mode === 'shared',
              reason:
                kernelDispatch.mode === 'shared' ? ('shared' as const) : ('forced-inline' as const),
              dispatched: kernelDispatch.dispatched,
              completed: kernelDispatch.completed,
            },
          }
        : {}),
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
  }
}

async function rebuild(message: ExecutionRebuildMessage): Promise<void> {
  const activeRealm = realm;
  if (
    activeRealm === undefined ||
    renderer === undefined ||
    message.worldIdentity !== activeRealm.world.identity
  )
    return;
  const previousWorldIdentity = activeRealm.world.identity;
  try {
    if (engineCanvas === undefined) return;
    const init: ExecutionInitMessage = { ...activeRealm.init, canvas: engineCanvas };
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
  if (message.kind === 'init') void initialize(message);
  else if (message.kind === 'frame') runFrame(message);
  else if (message.kind === 'rebuild') {
    void rebuildQueue.enqueue(() => rebuild(message));
  } else if (message.kind === 'dispose') {
    void (async () => {
      if (realm !== undefined) {
        await disposeRealm(realm);
        realm = undefined;
      }
      scope.close();
    })();
  }
};
