import { err, ok, type Result } from '@forgeax/engine-types';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError, type AppError as AppErrorType } from '../errors';
import { validateExecutionBootstrapData } from './bootstrap-entry';
import type {
  EngineToHostMessage,
  ExecutionFaultMessage,
  ExecutionInitMessage,
  ExecutionReadyMessage,
  HostToEngineMessage,
} from './protocol';

export interface EngineWorkerSession {
  readonly worker: Worker;
  readonly ready: ExecutionReadyMessage;
  post(message: HostToEngineMessage, transfer?: Transferable[]): void;
  listen(listener: (message: EngineToHostMessage) => void): () => void;
  dispose(): void;
}

export interface StartEngineWorkerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly bootstrapUrl: string;
  readonly bootstrapData?: import('./types').ExecutionBootstrapValue;
  readonly bootstrapPort?: MessagePort;
  readonly shaderManifestUrl?: string;
  readonly time?: import('@forgeax/engine-ecs').TimePolicy;
  readonly timeoutMs: number;
  readonly tier: import('./types').ExecutionTier;
  readonly workerFactory?: () => Worker;
}

function deadlineError(timeoutMs: number): AppErrorType {
  return new AppError({
    code: 'app-execution-deadline-exceeded',
    expected: APP_EXPECTED['app-execution-deadline-exceeded'],
    hint: APP_ERROR_HINTS['app-execution-deadline-exceeded'],
    detail: { phase: 'handshake', timeoutMs },
  });
}

function startupFault(message: ExecutionFaultMessage, moduleUrl: string): AppErrorType {
  return new AppError({
    code: 'app-execution-bootstrap-failed',
    expected: APP_EXPECTED['app-execution-bootstrap-failed'],
    hint: APP_ERROR_HINTS['app-execution-bootstrap-failed'],
    detail: { phase: 'bootstrap', moduleUrl, cause: message.detail },
  });
}

export async function startEngineWorker(
  options: StartEngineWorkerOptions,
): Promise<Result<EngineWorkerSession, AppErrorType>> {
  const validData = validateExecutionBootstrapData(options.bootstrapData, options.bootstrapUrl);
  if (!validData.ok) return validData;
  const worker =
    options.workerFactory?.() ??
    new Worker(new URL('./engine-worker-runtime.mjs', import.meta.url), {
      type: 'module',
      name: 'forgeax-engine',
    });
  const listeners = new Set<(message: EngineToHostMessage) => void>();
  let settled = false;
  let resolveReady: (result: Result<ExecutionReadyMessage, AppErrorType>) => void = () => {};
  const readyPromise = new Promise<Result<ExecutionReadyMessage, AppErrorType>>((resolve) => {
    resolveReady = resolve;
  });
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    worker.terminate();
    resolveReady(err(deadlineError(options.timeoutMs)));
  }, options.timeoutMs);
  worker.onmessage = (event: MessageEvent<EngineToHostMessage>) => {
    const message = event.data;
    if (!settled && message.kind === 'ready') {
      settled = true;
      clearTimeout(timeout);
      resolveReady(ok(message));
    } else if (!settled && message.kind === 'fault') {
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      resolveReady(err(startupFault(message, options.bootstrapUrl)));
    }
    for (const listener of listeners) listener(message);
  };
  worker.onerror = (event) => {
    if (settled) {
      const crash: ExecutionFaultMessage = {
        kind: 'fault',
        worldIdentity: null,
        source: 'runtime',
        code: 'worker-crashed',
        expected: 'Engine Worker remains alive while the App is running',
        hint: 'inspect the Worker error and create a new App; transferred canvas ownership is terminal',
        detail: { message: event.message },
        partialWrite: false,
        retryable: false,
      };
      for (const listener of listeners) listener(crash);
      return;
    }
    settled = true;
    clearTimeout(timeout);
    worker.terminate();
    resolveReady(
      err(
        startupFault(
          {
            kind: 'fault',
            worldIdentity: null,
            source: 'bootstrap',
            code: 'worker-error',
            expected: 'Engine Worker module loads',
            hint: 'inspect the Worker module graph',
            detail: { message: event.message },
            partialWrite: false,
            retryable: false,
          },
          options.bootstrapUrl,
        ),
      ),
    );
  };

  const offscreen = options.canvas.transferControlToOffscreen();
  const init: ExecutionInitMessage = {
    kind: 'init',
    canvas: offscreen,
    bootstrapUrl: options.bootstrapUrl,
    ...(options.bootstrapData === undefined ? {} : { bootstrapData: options.bootstrapData }),
    ...(options.bootstrapPort === undefined ? {} : { bootstrapPort: options.bootstrapPort }),
    ...(options.shaderManifestUrl !== undefined
      ? { shaderManifestUrl: options.shaderManifestUrl }
      : {}),
    ...(options.time !== undefined ? { time: options.time } : {}),
    tier: options.tier,
  };
  worker.postMessage(init, [
    offscreen,
    ...(options.bootstrapPort === undefined ? [] : [options.bootstrapPort]),
  ]);
  const ready = await readyPromise;
  if (!ready.ok) return ready;
  return ok({
    worker,
    ready: ready.value,
    post(message, transfer = []): void {
      worker.postMessage(message, transfer);
    },
    listen(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      worker.postMessage({ kind: 'dispose' } satisfies HostToEngineMessage);
      worker.terminate();
      listeners.clear();
    },
  });
}
