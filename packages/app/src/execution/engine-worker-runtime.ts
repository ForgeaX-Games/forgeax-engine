import { animationPlugin } from '@forgeax/engine-animation';
import {
  ASSET_REGISTRY_RESOURCE_KEY,
  AUDIO_ENGINE_RESOURCE_KEY,
  type AudioIntent,
  audioPlugin,
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
import { runBootstrapEntry } from './bootstrap-entry';
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

let world: World | undefined;
let renderer: Renderer | undefined;
let bootstrapUrl = '';
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
let kernelPool: KernelPool | undefined;
let realmInit: ExecutionInitMessage | undefined;
let pendingAudioIntents: AudioIntent[] = [];

const lazyKernelExecutor: SharedKernelExecutor = {
  warmup(kernel) {
    kernelPool ??= createKernelPool();
    kernelPool.warmup?.(kernel);
  },
  execute(kernel, spans) {
    kernelPool ??= createKernelPool();
    return kernelPool.execute(kernel, spans);
  },
};

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
    worldIdentity: world?.identity ?? null,
    source,
    code,
    expected,
    hint,
    detail: serializableDetail(cause),
    partialWrite,
    retryable: false,
  });
}

async function createRealm(init: ExecutionInitMessage, keepRenderer = false): Promise<boolean> {
  pendingAudioIntents = [];
  bootstrapUrl = init.bootstrapUrl;
  const nextWorld = new World({
    ...(init.time !== undefined ? { time: init.time } : {}),
    storage: init.tier === 'shared' ? 'shared' : 'local',
  });
  nextWorld.insertResource(INPUT_BACKEND_KEY, inputBackend);
  const audioBackend = createAudioIntentBackend({
    emit: (intent) => pendingAudioIntents.push(intent),
  });
  nextWorld.insertResource(AUDIO_ENGINE_RESOURCE_KEY, audioBackend);
  if (init.tier === 'shared') {
    nextWorld.insertResource('SharedKernelExecutor', lazyKernelExecutor);
  }
  if (!keepRenderer) {
    renderer = await createRenderer(
      init.canvas,
      {},
      init.shaderManifestUrl === undefined
        ? undefined
        : { shaderManifestUrl: init.shaderManifestUrl },
    );
    const ready = await renderer.ready;
    if (!ready.ok) throw ready.error;
  }
  if (renderer?.assets !== undefined) {
    nextWorld.insertResource(ASSET_REGISTRY_RESOURCE_KEY, renderer.assets);
  }
  const plugins = await runPlugins(
    nextWorld,
    [scenePlugin(), animationPlugin(), statePlugin(), inputPlugin(), audioPlugin()],
    [],
  );
  if (!plugins.ok) throw plugins.error;
  const bootstrapped = await runBootstrapEntry(init.bootstrapUrl, nextWorld);
  if (!bootstrapped.ok) {
    postFault(
      'bootstrap',
      bootstrapped.error.code,
      bootstrapped.error.expected,
      bootstrapped.error.hint,
      bootstrapped.error.detail,
    );
    return false;
  }
  await kernelPool?.ready();
  world = nextWorld;
  lastFrameId = 0;
  return true;
}

async function initialize(message: ExecutionInitMessage): Promise<void> {
  try {
    engineCanvas = message.canvas;
    realmInit = message;
    if (!(await createRealm(message))) return;
    scope.postMessage({
      kind: 'ready',
      worldIdentity: world?.identity ?? '',
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
  if (world === undefined || renderer === undefined) return;
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
    const draw = renderer.draw([world], { owner: 0 });
    if (draw !== undefined && !draw.ok) throw draw.error;
    lastFrameId = message.frameId;
    const kernelDispatch = kernelPool?.takeLastDispatch() ?? null;
    const audioIntents = pendingAudioIntents;
    pendingAudioIntents = [];
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
  if (world === undefined || renderer === undefined || message.worldIdentity !== world.identity)
    return;
  const previousWorldIdentity = world.identity;
  try {
    if (engineCanvas === undefined) return;
    kernelPool?.dispose();
    kernelPool = undefined;
    const init: ExecutionInitMessage =
      realmInit === undefined
        ? { kind: 'init', canvas: engineCanvas, bootstrapUrl, tier: 'engine-worker' }
        : { ...realmInit, canvas: engineCanvas };
    if (!(await createRealm(init, true))) return;
    scope.postMessage({
      kind: 'rebuilt',
      previousWorldIdentity,
      worldIdentity: world?.identity ?? '',
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
  else if (message.kind === 'rebuild') void rebuild(message);
  else if (message.kind === 'dispose') {
    renderer?.dispose();
    kernelPool?.dispose();
    scope.close();
  }
};
