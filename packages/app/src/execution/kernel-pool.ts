import {
  bindSharedSpan,
  isSharedSpan,
  type KernelDispatchFailure,
  type KernelDispatchResult,
  type KernelDispatchSpan,
  type SharedKernelDispatch,
  type SharedKernelExecutor,
  type SharedSpanBinding,
  splitSharedSpan,
} from '@forgeax/engine-ecs';

export interface KernelPool extends SharedKernelExecutor {
  readonly laneCount: number;
  ready(): Promise<void>;
  takeLastDispatch(): KernelDispatchResult | null;
  dispose(): void;
}

interface KernelJobMessage {
  readonly kind: 'kernel-job';
  readonly moduleUrl: string;
  readonly binding: SharedSpanBinding;
  readonly control: Int32Array;
  readonly status: Int32Array;
  readonly jobIndex: number;
}

interface KernelInitMessage {
  readonly kind: 'kernel-init';
  readonly ready: Int32Array;
}

interface KernelPreloadMessage {
  readonly kind: 'kernel-preload';
  readonly moduleUrl: string;
  readonly control: Int32Array;
  readonly status: Int32Array;
  readonly jobIndex: number;
}

interface KernelPreflight {
  readonly control: Int32Array;
  readonly status: Int32Array;
}

export interface KernelPoolOptions {
  readonly lanes?: number;
  readonly timeoutMs?: number;
  readonly workerFactory?: () => Worker;
}

export function createKernelPool(options: KernelPoolOptions = {}): KernelPool {
  const hardware = globalThis.navigator?.hardwareConcurrency ?? 2;
  const laneCount = Math.max(1, Math.min(options.lanes ?? hardware - 1, 8));
  const timeoutMs = options.timeoutMs ?? 5_000;
  const workers = Array.from(
    { length: laneCount },
    () =>
      options.workerFactory?.() ??
      new Worker(new URL('./kernel-worker-runtime.mjs', import.meta.url), {
        type: 'module',
        name: 'forgeax-kernel',
      }),
  );
  let latest: KernelDispatchResult | null = null;
  let ready = false;
  const preflights = new Map<string, KernelPreflight>();
  const readyControl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const initMessage: KernelInitMessage = { kind: 'kernel-init', ready: readyControl };
  for (const worker of workers) worker.postMessage(initMessage);
  const waitFor = (control: Int32Array, expected: number, label: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const started = performance.now();
      const poll = (): void => {
        if (Atomics.load(control, 0) === expected) {
          resolve();
          return;
        }
        if (performance.now() - started >= timeoutMs) {
          for (const worker of workers) worker.terminate();
          reject(new Error(`${label} did not complete within ${timeoutMs}ms.`));
          return;
        }
        setTimeout(poll, 1);
      };
      poll();
    });

  const readyPromise = waitFor(
    readyControl,
    workers.length,
    'SharedKernel worker initialization',
  ).then(async () => {
    for (const [moduleUrl, preflight] of preflights) {
      await waitFor(
        preflight.control,
        workers.length,
        `SharedKernel module preflight for ${moduleUrl}`,
      );
      if (preflight.status.some((status) => status !== 1)) {
        throw new Error(`SharedKernel module preflight failed for ${moduleUrl}.`);
      }
    }
    ready = true;
  });

  return {
    laneCount,
    ready: () => readyPromise,
    warmup(kernel): void {
      if (preflights.has(kernel.moduleUrl)) return;
      const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      const status = new Int32Array(
        new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * workers.length),
      );
      preflights.set(kernel.moduleUrl, { control, status });
      for (const [jobIndex, worker] of workers.entries()) {
        const message: KernelPreloadMessage = {
          kind: 'kernel-preload',
          moduleUrl: kernel.moduleUrl,
          control,
          status,
          jobIndex,
        };
        worker.postMessage(message);
      }
    },
    takeLastDispatch: () => {
      const dispatch = latest;
      latest = null;
      return dispatch;
    },
    execute(
      kernel: SharedKernelDispatch,
      spans: readonly KernelDispatchSpan[],
    ): KernelDispatchResult | KernelDispatchFailure {
      const preflight = preflights.get(kernel.moduleUrl);
      if (preflight === undefined) {
        this.warmup?.(kernel);
        latest = { mode: 'forced-inline', dispatched: 0, completed: 0, waitMs: 0 };
        return {
          cause: new Error('SharedKernel module was not preflighted before frame dispatch.'),
          dispatched: 0,
          completed: 0,
          partialWrite: false,
        };
      }
      if (
        Atomics.load(preflight.control, 0) !== workers.length ||
        preflight.status.some((status) => status !== 1)
      ) {
        latest = { mode: 'forced-inline', dispatched: 0, completed: 0, waitMs: 0 };
        return {
          cause: new Error('SharedKernel module preflight is incomplete or failed.'),
          dispatched: 0,
          completed: 0,
          partialWrite: false,
        };
      }
      if (!ready && Atomics.load(readyControl, 0) === workers.length) ready = true;
      if (!ready) {
        latest = { mode: 'forced-inline', dispatched: 0, completed: 0, waitMs: 0 };
        return {
          cause: new Error('SharedKernel workers were not warmed before frame dispatch.'),
          dispatched: 0,
          completed: 0,
          partialWrite: false,
        };
      }
      const bindings = spans.flatMap(({ queryIndex, span }) =>
        splitSharedSpan(bindSharedSpan(kernel, span, queryIndex), laneCount),
      );
      if (bindings.length === 0) {
        latest = { mode: 'forced-inline', dispatched: 0, completed: 0, waitMs: 0 };
        return latest;
      }
      if (!bindings.every(isSharedSpan)) {
        latest = { mode: 'forced-inline', dispatched: 0, completed: 0, waitMs: 0 };
        return {
          cause: new Error('SharedKernel received a non-SAB QuerySpan.'),
          dispatched: 0,
          completed: 0,
          partialWrite: false,
        };
      }
      const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      const status = new Int32Array(
        new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * bindings.length),
      );
      const started = performance.now();
      for (const [index, binding] of bindings.entries()) {
        const message: KernelJobMessage = {
          kind: 'kernel-job',
          moduleUrl: kernel.moduleUrl,
          binding,
          control,
          status,
          jobIndex: index,
        };
        workers[index % workers.length]?.postMessage(message);
      }
      while (Atomics.load(control, 0) < bindings.length) {
        const observed = Atomics.load(control, 0);
        const wait = Atomics.wait(control, 0, observed, timeoutMs);
        if (wait === 'timed-out') {
          for (const worker of workers) worker.terminate();
          return {
            cause: new Error(`SharedKernel deadline exceeded after ${timeoutMs}ms.`),
            dispatched: bindings.length,
            completed: observed,
            partialWrite: bindings.length > 0,
          };
        }
      }
      const completed = status.reduce((count, value) => count + (value === 1 ? 1 : 0), 0);
      const failed = status.some((value) => value === -1);
      if (failed) {
        return {
          cause: new Error('SharedKernel worker failed.'),
          dispatched: bindings.length,
          completed,
          partialWrite: bindings.length > 0,
        };
      }
      latest = {
        mode: 'shared',
        dispatched: bindings.length,
        completed,
        waitMs: performance.now() - started,
      };
      return latest;
    },
    dispose(): void {
      for (const worker of workers) worker.terminate();
    },
  };
}
