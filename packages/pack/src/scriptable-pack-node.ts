import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AssetGuid, Result } from '@forgeax/engine-types';
import { AssetError, err, ImportError, ok } from '@forgeax/engine-types';
import {
  type ProducerSemanticIdentityInput,
  producerRelativeDdcKey,
} from './evidence/source-inventory.js';
import {
  type AnyScriptablePackDefinition,
  type PackAuthoringError,
  type PackBuildContextWithoutParameters,
  type PackBuildResult,
  validatePackDefinition,
} from './pack-authoring.js';
import type { AssetReader, ScriptablePackSourceClosureEntry } from './scriptable-pack.js';
import {
  createScriptablePackSourceSnapshot,
  type ScriptablePackSourceSnapshot,
} from './scriptable-pack-source-snapshot.js';

export {
  createScriptablePackSourceSnapshot,
  type ScriptablePackSourceSnapshot,
} from './scriptable-pack-source-snapshot.js';

const IMPORT_META_RESOLVE_FLAG = '--experimental-import-meta-resolve';

function scriptablePackWorkerExecArgv(): string[] {
  // import.meta.resolve(parentURL) is the canonical ESM resolver, but Node
  // keeps its parentURL overload behind this flag. Filter --input-type as
  // well: stdin/eval hosts may pass it through process.execArgv, and Node
  // rejects that option inside a file-backed worker.
  const inherited = process.execArgv.filter((arg) => !arg.startsWith('--input-type'));
  return inherited.includes(IMPORT_META_RESOLVE_FLAG)
    ? inherited
    : [...inherited, IMPORT_META_RESOLVE_FLAG];
}

export interface ScriptablePackModuleExecutor {
  load(sourcePath: string, sources?: Readonly<Record<string, string>>): Promise<unknown>;
  dispose?(reason: 'complete' | 'timeout' | 'failure'): void | Promise<void>;
}

interface SerializedScriptablePackBuildContext {
  readonly packageId: readonly number[];
  readonly values?: Readonly<Record<string, unknown>>;
}

interface WorkerBackedScriptablePackExecutor {
  readonly supportsPackParameters: true;
}

export interface ScriptablePackModuleExecutorPool {
  acquire(): Promise<ScriptablePackModuleExecutor>;
  dispose(): Promise<void>;
}

export interface ScriptablePackModuleExecutorPoolOptions {
  readonly maxWorkers?: number;
  readonly maxTasksPerWorker?: number;
}

export function scriptablePackDdcKey(input: ProducerSemanticIdentityInput): string {
  return producerRelativeDdcKey(input);
}

export interface OptionalBuildCache<T> {
  readonly read: () => Promise<T | null>;
  readonly coldCook: () => Promise<T>;
}

/** Build CAS is a performance hint; source cold cook remains the correctness path. */
export async function readOptionalBuildCache<T>(cache: OptionalBuildCache<T>): Promise<{
  readonly value: T;
  readonly fromCache: boolean;
}> {
  try {
    const cached = await cache.read();
    if (cached !== null) return { value: cached, fromCache: true };
  } catch {
    // Cache deletion, read-only storage, and corrupt optional objects fail open.
  }
  return { value: await cache.coldCook(), fromCache: false };
}

/** A standalone inventory has a fresh snapshot; build owners may share one explicitly. */
export async function inventoryScriptablePackSource(
  sourcePath: string,
  initialSourceText?: string,
  resolveImport?: (sourcePath: string, specifier: string) => Promise<string | undefined>,
  snapshot = createScriptablePackSourceSnapshot(),
): Promise<readonly ScriptablePackSourceClosureEntry[]> {
  return snapshot.inventory(sourcePath, initialSourceText, resolveImport);
}

interface StructuredFailure {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly hint?: unknown;
  readonly detail?: unknown;
  readonly message?: unknown;
}

function serializeFailure(value: unknown): StructuredFailure {
  if (value !== null && typeof value === 'object') {
    const failure = value as Record<string, unknown>;
    return {
      name: failure.name,
      code: failure.code,
      expected: failure.expected,
      actual: failure.actual,
      hint: failure.hint,
      detail: failure.detail,
      message: failure.message,
    };
  }
  return { message: String(value) };
}

function hydrateFailure(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const failure = value as StructuredFailure;
  if (
    failure.name === 'AssetError' &&
    typeof failure.code === 'string' &&
    typeof failure.expected === 'string' &&
    typeof failure.hint === 'string'
  ) {
    const args = {
      code: failure.code as ConstructorParameters<typeof AssetError>[0]['code'],
      expected: failure.expected,
      hint: failure.hint,
    };
    return failure.detail === undefined
      ? new AssetError(args)
      : new AssetError({
          ...args,
          detail: failure.detail as NonNullable<
            ConstructorParameters<typeof AssetError>[0]['detail']
          >,
        });
  }
  if (
    failure.name === 'ImportError' &&
    typeof failure.code === 'string' &&
    typeof failure.expected === 'string' &&
    typeof failure.hint === 'string' &&
    failure.detail !== undefined
  ) {
    return new ImportError({
      code: failure.code as ConstructorParameters<typeof ImportError>[0]['code'],
      expected: failure.expected,
      hint: failure.hint,
      detail: failure.detail as ConstructorParameters<typeof ImportError>[0]['detail'],
      ...(typeof failure.actual === 'string' ? { actual: failure.actual } : {}),
    });
  }
  if (typeof failure.message === 'string') {
    const error = new Error(failure.message);
    if (typeof failure.name === 'string') error.name = failure.name;
    return error;
  }
  return value;
}

class WorkerScriptablePackExecutor
  implements ScriptablePackModuleExecutor, WorkerBackedScriptablePackExecutor
{
  readonly supportsPackParameters = true as const;
  private worker: Worker | undefined;
  private compileRoot: string | undefined;
  private nextBuildId = 0;
  private disposal: Promise<void> | undefined;
  private build:
    | {
        readonly id: number;
        readonly reader: AssetReader;
        readonly resolve: (value: unknown) => void;
        readonly reject: (reason: unknown) => void;
      }
    | undefined;

  async load(sourcePath: string, sources?: Readonly<Record<string, string>>): Promise<unknown> {
    const workerUrl = scriptablePackWorkerUrl();
    const compileRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-scriptable-pack-'));
    this.compileRoot = compileRoot;
    const worker = new Worker(workerUrl, {
      workerData: { sourcePath: resolve(sourcePath), compileRoot, sources },
      execArgv: scriptablePackWorkerExecArgv(),
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
    });
    this.worker = worker;
    worker.on('message', (message: unknown) => this.onMessage(message));
    worker.unref();
    return new Promise((resolveLoad, rejectLoad) => {
      const onMessage = (message: unknown): void => {
        if (message === null || typeof message !== 'object') return;
        const value = message as Record<string, unknown>;
        if (value.kind === 'loaded') {
          // The scan keeps this executor alive for the later no-reopen build
          // route, but an idle source worker must not keep a Vite/Vitest host
          // process alive after its own work has settled.
          worker.unref();
          worker.off('message', onMessage);
          resolveLoad({
            default:
              value.definition === undefined
                ? undefined
                : {
                    ...(value.definition as Record<string, unknown>),
                    build: (
                      readByGuid: AssetReader['readByGuid'],
                      context?: SerializedScriptablePackBuildContext,
                    ) => this.runBuild({ readByGuid }, context),
                  },
          });
        } else if (value.kind === 'load-threw') {
          worker.off('message', onMessage);
          rejectLoad(hydrateFailure(value.error));
        }
      };
      worker.on('message', onMessage);
      const fail = (error: Error): void => {
        rejectLoad(error);
        const active = this.build;
        this.build = undefined;
        active?.reject(error);
        void this.dispose('failure');
      };
      worker.once('error', fail);
      worker.once('exit', (code) => {
        if (this.disposal !== undefined) return;
        fail(new Error(`ScriptablePack worker exited with code ${code}`));
      });
    });
  }

  dispose(reason: 'complete' | 'timeout' | 'failure' = 'complete'): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    const worker = this.worker;
    this.worker = undefined;
    const compileRoot = this.compileRoot;
    this.compileRoot = undefined;
    const active = this.build;
    this.build = undefined;
    if (active !== undefined) {
      active.reject(new Error(`ScriptablePack build disposed during ${reason}`));
    }
    this.disposal = (async () => {
      if (worker !== undefined) await worker.terminate();
      if (compileRoot !== undefined) await rm(compileRoot, { recursive: true, force: true });
    })();
    return this.disposal;
  }

  private runBuild(
    reader: AssetReader,
    context?: SerializedScriptablePackBuildContext,
  ): Promise<unknown> {
    const worker = this.worker;
    if (worker === undefined) return Promise.reject(new Error('ScriptablePack worker is closed'));
    if (this.build !== undefined)
      return Promise.reject(new Error('ScriptablePack worker already has an active build'));
    const id = this.nextBuildId++;
    return new Promise((resolveBuild, rejectBuild) => {
      this.build = { id, reader, resolve: resolveBuild, reject: rejectBuild };
      worker.postMessage({ kind: 'build', buildId: id, context });
    });
  }

  private onMessage(message: unknown): void {
    if (message === null || typeof message !== 'object') return;
    const value = message as Record<string, unknown>;
    const active = this.build;
    if (active === undefined || value.buildId !== active.id) return;
    if (value.kind === 'asset-read' && typeof value.readId === 'number') {
      void active.reader
        .readByGuid(value.guid as AssetGuid)
        .then((result) =>
          this.worker?.postMessage({
            kind: 'asset-result',
            readId: value.readId,
            result:
              result.ok === true ? result : { ...result, error: serializeFailure(result.error) },
          }),
        )
        .catch((error: unknown) => {
          if (this.build?.id !== active.id) return;
          this.build = undefined;
          active.reject(error);
          void this.dispose('failure');
        });
      return;
    }
    this.build = undefined;
    if (value.kind === 'build-result') active.resolve(value.result);
    else if (value.kind === 'build-threw') active.reject(hydrateFailure(value.error));
    else this.build = active;
  }
}

function scriptablePackWorkerUrl(): URL {
  const bundledWorker = new URL('./scriptable-pack-worker.mjs', import.meta.url);
  return existsSync(fileURLToPath(bundledWorker))
    ? bundledWorker
    : new URL('../dist/scriptable-pack-worker.mjs', import.meta.url);
}

class ReusableWorkerScriptablePackExecutor
  implements ScriptablePackModuleExecutor, WorkerBackedScriptablePackExecutor
{
  readonly supportsPackParameters = true as const;
  private readonly worker: Worker;
  private readonly compileRootReady = mkdtemp(resolve(tmpdir(), 'forgeax-scriptable-pack-pool-'));
  private compileRoot: string | undefined;
  private nextLoadId = 0;
  private nextBuildId = 0;
  private pendingLoad:
    | {
        readonly id: number;
        readonly resolve: (value: unknown) => void;
        readonly reject: (reason: unknown) => void;
      }
    | undefined;
  private build:
    | {
        readonly id: number;
        readonly reader: AssetReader;
        readonly resolve: (value: unknown) => void;
        readonly reject: (reason: unknown) => void;
      }
    | undefined;
  private disposal: Promise<void> | undefined;
  private forceDispose = false;
  private failed = false;
  private taskCount = 0;
  private released = false;

  constructor(
    private readonly maxTasksPerWorker: number,
    private readonly release: (
      executor: ReusableWorkerScriptablePackExecutor,
      reusable: boolean,
    ) => void,
  ) {
    this.worker = new Worker(scriptablePackWorkerUrl(), {
      workerData: { mode: 'reusable' },
      execArgv: scriptablePackWorkerExecArgv(),
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
    });
    this.worker.on('message', (message: unknown) => this.onMessage(message));
    this.worker.on('error', (error: Error) => {
      this.failed = true;
      this.rejectActive(error);
      void this.dispose('failure');
    });
    this.worker.on('exit', (code) => {
      if (this.disposal !== undefined) return;
      this.failed = true;
      this.rejectActive(new Error(`ScriptablePack worker exited with code ${code}`));
      void this.dispose('failure');
    });
    // Listener registration can retain the worker's MessagePort in Node.
    // A reusable worker must not keep a completed Vite build alive while its
    // pool is draining; it still processes messages while the host is live.
    this.worker.unref();
  }

  async load(sourcePath: string, sources?: Readonly<Record<string, string>>): Promise<unknown> {
    const activeDisposal = this.disposal;
    if (activeDisposal !== undefined) {
      await activeDisposal;
      if (this.failed) {
        return Promise.reject(new Error('ScriptablePack executor is not leased'));
      }
      this.disposal = undefined;
    }
    this.released = false;
    if (this.pendingLoad !== undefined || this.build !== undefined) {
      return Promise.reject(new Error('ScriptablePack executor already has an active task'));
    }
    const compileRoot = this.compileRoot ?? (await this.compileRootReady);
    if (this.disposal !== undefined) {
      const disposal = this.disposal;
      await disposal;
      if (this.failed) {
        return Promise.reject(new Error('ScriptablePack executor is not leased'));
      }
      this.disposal = undefined;
    }
    const loadId = this.nextLoadId++;
    this.compileRoot = compileRoot;
    this.taskCount += 1;
    return new Promise((resolveLoad, rejectLoad) => {
      this.pendingLoad = { id: loadId, resolve: resolveLoad, reject: rejectLoad };
      try {
        this.worker.postMessage({
          kind: 'load',
          loadId,
          sourcePath: resolve(sourcePath),
          compileRoot,
          sources,
        });
      } catch (error) {
        this.pendingLoad = undefined;
        rejectLoad(error);
        void this.dispose('failure');
      }
    });
  }

  dispose(reason: 'complete' | 'timeout' | 'failure' = 'complete'): Promise<void> {
    if (reason === 'failure') this.forceDispose = true;
    const activeDisposal = this.disposal;
    if (activeDisposal !== undefined) {
      return activeDisposal;
    }
    this.rejectActive(new Error(`ScriptablePack task disposed during ${reason}`));
    this.disposal = (async () => {
      const compileRoot = this.compileRoot ?? (await this.compileRootReady);
      const reusable =
        reason === 'complete' &&
        !this.failed &&
        !this.forceDispose &&
        this.taskCount < this.maxTasksPerWorker;
      this.forceDispose = false;
      if (!reusable) {
        this.compileRoot = undefined;
        await this.worker.terminate();
        await rm(compileRoot, { recursive: true, force: true });
      }
      this.released = true;
      this.disposal = undefined;
      this.release(this, reusable);
    })();
    return this.disposal;
  }

  private rejectActive(error: unknown): void {
    const loading = this.pendingLoad;
    this.pendingLoad = undefined;
    loading?.reject(error);
    const building = this.build;
    this.build = undefined;
    building?.reject(error);
  }

  private runBuild(
    reader: AssetReader,
    context?: SerializedScriptablePackBuildContext,
  ): Promise<unknown> {
    if (this.released || this.disposal !== undefined) {
      return Promise.reject(new Error('ScriptablePack executor is not leased'));
    }
    if (this.build !== undefined) {
      return Promise.reject(new Error('ScriptablePack worker already has an active build'));
    }
    const id = this.nextBuildId++;
    return new Promise((resolveBuild, rejectBuild) => {
      this.build = { id, reader, resolve: resolveBuild, reject: rejectBuild };
      try {
        this.worker.postMessage({ kind: 'build', buildId: id, context });
      } catch (error) {
        this.build = undefined;
        rejectBuild(error);
        void this.dispose('failure');
      }
    });
  }

  private onMessage(message: unknown): void {
    if (message === null || typeof message !== 'object') return;
    const value = message as Record<string, unknown>;
    const loading = this.pendingLoad;
    if (loading !== undefined && value.kind === 'loaded' && value.loadId === loading.id) {
      this.pendingLoad = undefined;
      loading.resolve({
        default:
          value.definition === undefined
            ? undefined
            : {
                ...(value.definition as Record<string, unknown>),
                build: (
                  readByGuid: AssetReader['readByGuid'],
                  context?: SerializedScriptablePackBuildContext,
                ) => this.runBuild({ readByGuid }, context),
              },
      });
      return;
    }
    if (loading !== undefined && value.kind === 'load-threw' && value.loadId === loading.id) {
      this.pendingLoad = undefined;
      loading.reject(hydrateFailure(value.error));
      return;
    }
    const active = this.build;
    if (active === undefined || value.buildId !== active.id) return;
    if (value.kind === 'asset-read' && typeof value.readId === 'number') {
      void active.reader
        .readByGuid(value.guid as AssetGuid)
        .then((result) =>
          this.worker.postMessage({
            kind: 'asset-result',
            readId: value.readId,
            result:
              result.ok === true ? result : { ...result, error: serializeFailure(result.error) },
          }),
        )
        .catch((error: unknown) => {
          if (this.build?.id !== active.id) return;
          this.build = undefined;
          active.reject(error);
          void this.dispose('failure');
        });
      return;
    }
    this.build = undefined;
    if (value.kind === 'build-result') active.resolve(value.result);
    else if (value.kind === 'build-threw') active.reject(hydrateFailure(value.error));
    else this.build = active;
  }
}

class DefaultScriptablePackModuleExecutorPool implements ScriptablePackModuleExecutorPool {
  private readonly maxWorkers: number;
  private readonly maxTasksPerWorker: number;
  private readonly idle: ReusableWorkerScriptablePackExecutor[] = [];
  private readonly waiters: {
    readonly resolve: (executor: ScriptablePackModuleExecutor) => void;
    readonly reject: (reason: unknown) => void;
  }[] = [];
  private readonly executors = new Set<ReusableWorkerScriptablePackExecutor>();
  private workerCount = 0;
  private closed = false;

  constructor(options: ScriptablePackModuleExecutorPoolOptions = {}) {
    this.maxWorkers = Math.max(1, Math.trunc(options.maxWorkers ?? 2));
    this.maxTasksPerWorker = Math.max(1, Math.trunc(options.maxTasksPerWorker ?? 32));
  }

  acquire(): Promise<ScriptablePackModuleExecutor> {
    if (this.closed) return Promise.reject(new Error('ScriptablePack executor pool is closed'));
    const executor = this.idle.pop();
    if (executor !== undefined) return Promise.resolve(executor);
    if (this.workerCount < this.maxWorkers) {
      this.workerCount += 1;
      return Promise.resolve(this.createExecutor());
    }
    return new Promise((resolveAcquire, rejectAcquire) =>
      this.waiters.push({ resolve: resolveAcquire, reject: rejectAcquire }),
    );
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(new Error('ScriptablePack executor pool is closed'));
    }
    this.idle.splice(0);
    await Promise.all([...this.executors].map((executor) => executor.dispose('failure')));
  }

  private createExecutor(): ReusableWorkerScriptablePackExecutor {
    const executor = new ReusableWorkerScriptablePackExecutor(
      this.maxTasksPerWorker,
      (executor, reusable) => {
        if (this.closed) {
          this.executors.delete(executor);
          if (!reusable) this.workerCount -= 1;
          return;
        }
        if (!reusable) {
          this.executors.delete(executor);
          this.workerCount -= 1;
        } else {
          this.idle.push(executor);
        }
        this.drain();
      },
    );
    this.executors.add(executor);
    return executor;
  }

  private drain(): void {
    if (this.closed) return;
    while (this.waiters.length > 0) {
      const idle = this.idle.pop();
      if (idle !== undefined) {
        this.waiters.shift()?.resolve(idle);
        continue;
      }
      if (this.workerCount >= this.maxWorkers) return;
      this.workerCount += 1;
      this.waiters.shift()?.resolve(this.createExecutor());
    }
  }
}

export function createScriptablePackModuleExecutorPool(
  options: ScriptablePackModuleExecutorPoolOptions = {},
): ScriptablePackModuleExecutorPool {
  return new DefaultScriptablePackModuleExecutorPool(options);
}

export interface LoadScriptablePackOptions {
  readonly timeoutMs?: number;
  readonly buildTimeoutMs?: number;
  readonly executor?: ScriptablePackModuleExecutor;
  readonly metadataOnly?: boolean;
  readonly sourceSnapshot?: ScriptablePackSourceSnapshot;
}

function scriptablePackLoadFailure(
  sourcePath: string,
  reason: 'module-load' | 'timeout',
  phase: 'module-load' | 'build',
  diagnostic: string,
  timeoutMs?: number,
): PackAuthoringError {
  return {
    code: 'pack-parameter-invalid',
    expected: 'a trusted Pack v2 authoring module with a valid default export',
    hint: 'repair the source module or its build timeout, then inspect the Pack again',
    detail: {
      sourcePath,
      reason,
      phase,
      diagnostic,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  };
}

/** Load a ScriptablePack source contract in an isolated module executor. */
export async function loadScriptablePack(
  sourcePath: string,
  options: LoadScriptablePackOptions = {},
): Promise<Result<Readonly<AnyScriptablePackDefinition>, PackAuthoringError>> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  // Keep authored builds bounded, but give legitimate procedural packs the
  // same cold-start budget already used for module initialization. The old
  // five-second default rejected large production packs before they could
  // publish a result.
  const buildTimeoutMs = options.buildTimeoutMs ?? 15_000;
  const executor = options.executor ?? new WorkerScriptablePackExecutor();
  let disposeReason: 'complete' | 'timeout' | 'failure' | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutSignal = Symbol('scriptable-pack-module-timeout');
    const loaded = await Promise.race([
      (async () => {
        const sources = await options.sourceSnapshot?.moduleSources(sourcePath);
        return executor.load(sourcePath, sources);
      })(),
      new Promise<typeof timeoutSignal>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutSignal), timeoutMs);
      }),
    ]);
    if (loaded === timeoutSignal) {
      disposeReason = 'timeout';
      return err(
        scriptablePackLoadFailure(
          sourcePath,
          'timeout',
          'module-load',
          `Pack module initialization exceeded ${timeoutMs}ms`,
          timeoutMs,
        ),
      );
    }
    const moduleValue =
      loaded !== null && typeof loaded === 'object' && 'default' in loaded
        ? (loaded as { readonly default: unknown }).default
        : undefined;
    const validated = validatePackDefinition(moduleValue, sourcePath);
    if (!validated.ok) {
      disposeReason = 'failure';
      return validated;
    }
    if (options.metadataOnly === true) {
      disposeReason = 'complete';
      return ok(validated.value);
    }
    const definition = validated.value;
    const build = definition.build as unknown as (
      first: unknown,
      context?: SerializedScriptablePackBuildContext,
    ) => PackBuildResult;
    return ok({
      ...definition,
      build: async (
        context: PackBuildContextWithoutParameters,
      ): Promise<Awaited<PackBuildResult>> => {
        let buildTimedOut = false;
        let buildTimeout: ReturnType<typeof setTimeout> | undefined;
        const timeoutResult = err(
          scriptablePackLoadFailure(
            sourcePath,
            'timeout',
            'build',
            `ScriptablePack build exceeded ${buildTimeoutMs}ms`,
            buildTimeoutMs,
          ),
        );
        try {
          const invocation =
            'supportsPackParameters' in executor &&
            (executor as Partial<WorkerBackedScriptablePackExecutor>).supportsPackParameters ===
              true
              ? build(context.readByGuid, {
                  packageId: [...context.packageId],
                  ...('values' in context && context.values !== undefined
                    ? { values: context.values as Readonly<Record<string, unknown>> }
                    : {}),
                })
              : definition.build(context as never);
          const built = await Promise.race([
            Promise.resolve(invocation),
            new Promise<Awaited<PackBuildResult>>((resolve) => {
              buildTimeout = setTimeout(() => {
                buildTimedOut = true;
                resolve(timeoutResult as Awaited<PackBuildResult>);
              }, buildTimeoutMs);
            }),
          ]);
          if (buildTimedOut) {
            await executor.dispose?.('timeout');
            return built;
          }
          await executor.dispose?.('complete');
          return built;
        } catch (error) {
          await executor.dispose?.('failure');
          throw error;
        } finally {
          if (buildTimeout !== undefined) clearTimeout(buildTimeout);
        }
      },
    } as AnyScriptablePackDefinition);
  } catch (error) {
    disposeReason = 'failure';
    return err(
      scriptablePackLoadFailure(
        sourcePath,
        'module-load',
        'module-load',
        error instanceof Error ? error.message : String(error),
      ),
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (disposeReason !== undefined) await executor.dispose?.(disposeReason);
  }
}
