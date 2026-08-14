import { animationPlugin } from '@forgeax/engine-animation';
import {
  ASSET_REGISTRY_RESOURCE_KEY,
  AUDIO_ENGINE_RESOURCE_KEY,
  type AudioIntent,
  createAudioIntentBackend,
} from '@forgeax/engine-audio';
import type { SharedKernelExecutor } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import {
  INPUT_BACKEND_KEY,
  type InputBackend,
  type InputBackendSample,
} from '@forgeax/engine-input';
import { runPlugins } from '@forgeax/engine-plugin';
import type { Renderer } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import { scenePlugin } from '@forgeax/engine-scene';
import { statePlugin } from '@forgeax/engine-state';
import { inputPlugin } from '../plugin-factories';
import { commitAttachedWorld, SerializedRebuildQueue } from './attached-world-swap';
import {
  type PreparedExecutionBootstrap,
  prepareBootstrapEntry,
  runPreparedBootstrap,
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
  readonly cleanups: Array<() => void>;
  pendingAudioIntents: AudioIntent[];
  kernelPool: KernelPool | undefined;
}

let realm: WorkerRealm | undefined;
const rebuildQueue = new SerializedRebuildQueue();

const inputBackend: InputBackend = {
  sample: () => currentSample,
  detach: () => {},
};

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

function flushRealmCleanups(target: WorkerRealm): void {
  const pending = target.cleanups.splice(0);
  for (const cleanup of pending.reverse()) {
    try {
      cleanup();
    } catch (cause) {
      postFault(
        'runtime',
        'app-system-update-failed',
        'execution bootstrap cleanup completes',
        'inspect the realm-local cleanup callback',
        cause,
      );
    }
  }
}

function registerRealmCleanup(target: WorkerRealm, cleanup: () => void): () => void {
  target.cleanups.push(cleanup);
  return () => {
    const index = target.cleanups.indexOf(cleanup);
    if (index >= 0) target.cleanups.splice(index, 1);
  };
}

function disposeRealm(target: WorkerRealm): void {
  flushRealmCleanups(target);
  target.kernelPool?.dispose();
  target.kernelPool = undefined;
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
    cleanups: [],
    pendingAudioIntents: [],
    kernelPool: undefined,
  };
  nextWorld.insertResource(INPUT_BACKEND_KEY, inputBackend);
  const audioBackend = createAudioIntentBackend({
    emit: (intent) => candidate.pendingAudioIntents.push(intent),
  });
  nextWorld.insertResource(AUDIO_ENGINE_RESOURCE_KEY, audioBackend);
  if (init.tier === 'shared') {
    const kernelExecutor: SharedKernelExecutor = {
      warmup(kernel) {
        candidate.kernelPool ??= createKernelPool();
        candidate.kernelPool.warmup?.(kernel);
      },
      execute(kernel, spans) {
        candidate.kernelPool ??= createKernelPool();
        return candidate.kernelPool.execute(kernel, spans);
      },
    };
    nextWorld.insertResource('SharedKernelExecutor', kernelExecutor);
  }
  let candidateRenderer: Renderer | undefined;
  const previousRenderer = renderer;
  let previousSurfaceReleased = false;
  try {
    if (previousRenderer !== undefined) {
      const released = previousRenderer.releaseSurface();
      if (!released.ok) throw released.error;
      previousSurfaceReleased = true;
    }
    candidateRenderer = await createRenderer(
      init.canvas,
      prepared.features === undefined ? {} : { features: prepared.features },
      init.shaderManifestUrl === undefined
        ? undefined
        : { shaderManifestUrl: init.shaderManifestUrl },
    );
    const ready = await candidateRenderer.ready;
    if (!ready.ok) throw ready.error;
    if (candidateRenderer.assets !== undefined) {
      nextWorld.insertResource(ASSET_REGISTRY_RESOURCE_KEY, candidateRenderer.assets);
    }
    const plugins = await runPlugins(
      nextWorld,
      [scenePlugin(), animationPlugin(), statePlugin(), inputPlugin()],
      prepared.plugins ?? [],
    );
    if (!plugins.ok) throw plugins.error;
    const activeRenderer = candidateRenderer;
    const previousRealm = realm;
    const committed = await commitAttachedWorld(
      candidateRenderer,
      previousRealm?.world,
      nextWorld,
      async () => {
        const bootstrapped = await runPreparedBootstrap(init.bootstrapUrl, prepared, {
          world: nextWorld,
          renderer: activeRenderer,
          assets: activeRenderer.assets,
          data: init.bootstrapData,
          ...(init.bootstrapPort === undefined ? {} : { port: init.bootstrapPort }),
          registerCleanup: (cleanup) => registerRealmCleanup(candidate, cleanup),
          setPointerLockAllowed(allowed): void {
            scope.postMessage({
              kind: 'host-control',
              command: 'set-pointer-lock-allowed',
              allowed,
            });
          },
        });
        if (!bootstrapped.ok) {
          postBootstrapFault(bootstrapped.error);
          return false;
        }
        await candidate.kernelPool?.ready();
        return true;
      },
    );
    if (!committed) {
      disposeRealm(candidate);
      activeRenderer.dispose();
      if (previousSurfaceReleased) previousRenderer?.restoreSurface();
      return false;
    }
    realm = candidate;
    renderer = activeRenderer;
    lastFrameId = 0;
    if (previousRealm !== undefined) disposeRealm(previousRealm);
    if (previousRenderer !== undefined) previousRenderer.dispose();
    return true;
  } catch (cause) {
    disposeRealm(candidate);
    candidateRenderer?.dispose();
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
    const draw = renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
    if (draw !== undefined && !draw.ok) throw draw.error;
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
    if (realm !== undefined) {
      realm.init.bootstrapPort?.close();
      disposeRealm(realm);
      realm = undefined;
    }
    renderer?.dispose();
    scope.close();
  }
};
