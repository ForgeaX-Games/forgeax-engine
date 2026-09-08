import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AssetGuid, Result } from '@forgeax/engine-types';
import { AssetError, err, ImportError, ok } from '@forgeax/engine-types';
import ts from 'typescript';
import {
  type ProducerSemanticIdentityInput,
  producerRelativeDdcKey,
} from './evidence/source-inventory.js';
import { AssetGuid as AssetGuidCodec } from './guid.js';
import {
  type AssetReader,
  projectScriptablePackMeta,
  type ScriptablePackAssetKind,
  type ScriptablePackAuthoringMutation,
  type ScriptablePackAuthoringPort,
  type ScriptablePackDefinition,
  type ScriptablePackError,
  type ScriptablePackReadError,
  type ScriptablePackSourceClosureEntry,
  validateScriptablePackDefinition,
} from './scriptable-pack.js';

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
  load(sourcePath: string): Promise<unknown>;
  dispose?(reason: 'complete' | 'timeout' | 'failure'): void | Promise<void>;
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

export interface LoadScriptablePackOptions {
  /** Maximum time allowed for module initialization in the isolated worker. */
  readonly timeoutMs?: number;
  /** Maximum time allowed for one definition.build(reader) in the isolated worker. */
  readonly buildTimeoutMs?: number;
  readonly executor?: ScriptablePackModuleExecutor;
  /** Release the isolated loader after identity projection when build will not be called. */
  readonly metadataOnly?: boolean;
}

async function resolveRelativeImport(
  sourcePath: string,
  specifier: string,
): Promise<string | undefined> {
  if (!specifier.startsWith('.')) return undefined;
  const raw = resolve(dirname(sourcePath), specifier);
  const candidates =
    extname(raw).length > 0
      ? [raw]
      : [
          raw,
          `${raw}.ts`,
          `${raw}.tsx`,
          `${raw}.mts`,
          `${raw}.js`,
          `${raw}.mjs`,
          `${raw}.json`,
          resolve(raw, 'index.ts'),
        ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue through deterministic extension candidates.
    }
  }
  return undefined;
}

/** Capture one immutable ScriptablePack module closure for inventory and production. */
export async function inventoryScriptablePackSource(
  sourcePath: string,
  initialSourceText?: string,
): Promise<readonly ScriptablePackSourceClosureEntry[]> {
  const root = await realpath(sourcePath);
  const pending = [root];
  const seen = new Set<string>();
  const entries: ScriptablePackSourceClosureEntry[] = [];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    const bytes =
      path === root && initialSourceText !== undefined
        ? new TextEncoder().encode(initialSourceText)
        : await readFile(path);
    entries.push({ path, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
    const source = new TextDecoder().decode(bytes);
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const resolved = await resolveRelativeImport(path, imported.fileName);
      if (resolved !== undefined) pending.push(await realpath(resolved));
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
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

class WorkerScriptablePackExecutor implements ScriptablePackModuleExecutor {
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

  async load(sourcePath: string): Promise<unknown> {
    const workerUrl = scriptablePackWorkerUrl();
    const compileRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-scriptable-pack-'));
    this.compileRoot = compileRoot;
    const worker = new Worker(workerUrl, {
      workerData: { sourcePath: resolve(sourcePath), compileRoot },
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
                    build: (reader: AssetReader) => this.runBuild(reader),
                  },
          });
        } else if (value.kind === 'load-threw') {
          worker.off('message', onMessage);
          rejectLoad(hydrateFailure(value.error));
        }
      };
      worker.on('message', onMessage);
      worker.once('error', rejectLoad);
      worker.once('exit', (code) => {
        if (code !== 0) rejectLoad(new Error(`ScriptablePack worker exited with code ${code}`));
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

  private runBuild(reader: AssetReader): Promise<unknown> {
    const worker = this.worker;
    if (worker === undefined) return Promise.reject(new Error('ScriptablePack worker is closed'));
    if (this.build !== undefined)
      return Promise.reject(new Error('ScriptablePack worker already has an active build'));
    const id = this.nextBuildId++;
    return new Promise((resolveBuild, rejectBuild) => {
      this.build = { id, reader, resolve: resolveBuild, reject: rejectBuild };
      worker.postMessage({ kind: 'build', buildId: id });
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

class ReusableWorkerScriptablePackExecutor implements ScriptablePackModuleExecutor {
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
      if (code === 0 || this.disposal !== undefined) return;
      this.failed = true;
      this.rejectActive(new Error(`ScriptablePack worker exited with code ${code}`));
      void this.dispose('failure');
    });
    // Listener registration can retain the worker's MessagePort in Node.
    // A reusable worker must not keep a completed Vite build alive while its
    // pool is draining; it still processes messages while the host is live.
    this.worker.unref();
  }

  async load(sourcePath: string): Promise<unknown> {
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

  private runBuild(reader: AssetReader): Promise<unknown> {
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
        this.worker.postMessage({ kind: 'build', buildId: id });
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
                build: (reader: AssetReader) => this.runBuild(reader),
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

function loadFailure(
  sourcePath: string,
  reason: 'module-load' | 'timeout',
  phase: 'module-load' | 'build',
  diagnostic: string,
  timeoutMs?: number,
): Result<never, ScriptablePackError> {
  return err({
    code: 'pack-source-load-failed',
    expected: 'a trusted synchronous module with a valid default ScriptablePack export',
    hint: 'repair the module load or initialization failure, then inspect Meta again',
    detail: {
      sourcePath,
      reason,
      phase,
      diagnostic,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  });
}

function buildTimeoutFailure(sourcePath: string, timeoutMs: number): ScriptablePackReadError {
  return {
    code: 'pack-source-load-failed',
    expected: 'a ScriptablePack build to settle within the configured build timeout',
    hint: 'repair the authored build, then retry through a fresh ScriptablePack generation',
    detail: {
      sourcePath,
      reason: 'timeout',
      phase: 'build',
      timeoutMs,
      diagnostic: `ScriptablePack build exceeded ${timeoutMs}ms`,
    },
  };
}

export async function loadScriptablePack(
  sourcePath: string,
  options: LoadScriptablePackOptions = {},
): Promise<Result<Readonly<ScriptablePackDefinition>, ScriptablePackError>> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const buildTimeoutMs = options.buildTimeoutMs ?? 5_000;
  const executor = options.executor ?? new WorkerScriptablePackExecutor();
  let disposeReason: 'complete' | 'timeout' | 'failure' | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutSignal = Symbol('scriptable-pack-module-timeout');
    const loaded = await Promise.race([
      executor.load(sourcePath),
      new Promise<typeof timeoutSignal>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutSignal), timeoutMs);
      }),
    ]);
    if (loaded === timeoutSignal) {
      disposeReason = 'timeout';
      return loadFailure(
        sourcePath,
        'timeout',
        'module-load',
        `ScriptablePack module initialization exceeded ${timeoutMs}ms`,
        timeoutMs,
      );
    }
    const moduleValue =
      loaded !== null && typeof loaded === 'object' && 'default' in loaded
        ? (loaded as { readonly default: unknown }).default
        : undefined;
    const validated = validateScriptablePackDefinition(moduleValue, sourcePath);
    if (!validated.ok) {
      disposeReason = 'failure';
      return validated;
    }
    if (options.metadataOnly === true) {
      disposeReason = 'complete';
      return validated;
    }
    const definition = validated.value;
    type BuildOutcome = Awaited<ReturnType<ScriptablePackDefinition['build']>>;
    return ok({
      ...definition,
      build: async (reader: AssetReader): Promise<BuildOutcome> => {
        let buildTimedOut = false;
        let buildTimeout: ReturnType<typeof setTimeout> | undefined;
        const timeoutResult = err(buildTimeoutFailure(sourcePath, buildTimeoutMs));
        try {
          const built = await Promise.race([
            Promise.resolve(definition.build(reader)),
            new Promise<BuildOutcome>((resolve) => {
              buildTimeout = setTimeout(() => {
                buildTimedOut = true;
                resolve(timeoutResult as BuildOutcome);
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
    });
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    disposeReason = 'failure';
    return loadFailure(sourcePath, 'module-load', 'module-load', diagnostic);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (disposeReason !== undefined) await executor.dispose?.(disposeReason);
  }
}

const CANONICAL_SCAFFOLD_MARKER = '// @forgeax-scriptable-pack canonical-v1';
const CANONICAL_MANIFEST_NAME = 'canonicalManifest';
const CANONICAL_MUTABLE_KINDS = new Set<ScriptablePackAssetKind>(['scene', 'mesh', 'material']);

interface CanonicalOutput {
  readonly guid: string;
  readonly kind: ScriptablePackAssetKind;
  readonly name?: string;
}

interface CanonicalManifest {
  readonly schemaVersion: '1.0.0';
  readonly packageId: string;
  readonly name?: string;
  readonly assets: Readonly<Record<string, CanonicalOutput>>;
  readonly externalAssets: Readonly<Record<string, string>>;
}

export interface FileSystemScriptablePackAuthoringOptions {
  /** All source and target paths are confined to this game root. */
  readonly gameRoot: string;
  readonly incomingRefs?: (sourcePath: string, sourceKey?: string) => Promise<readonly string[]>;
  readonly rebuild?: (
    sourcePath: string,
    mode: 'rebuild' | 'cold-cook',
  ) => Promise<Result<void, ScriptablePackError>>;
}

function authoringError(
  code:
    | 'pack-source-path-invalid'
    | 'pack-source-revision-conflict'
    | 'pack-source-mutation-unsupported'
    | 'pack-source-reference-conflict'
    | 'pack-source-write-failed',
  input: {
    readonly expected: string;
    readonly actual?: string;
    readonly hint: string;
    readonly retryable: boolean;
    readonly recoveryActions: readonly string[];
    readonly requestId?: string;
    readonly sourcePath?: string;
    readonly sourceKey?: string;
    readonly incomingRefs?: readonly string[];
  },
): ScriptablePackError {
  return {
    code,
    expected: input.expected,
    ...(input.actual === undefined ? {} : { actual: input.actual }),
    hint: input.hint,
    retryable: input.retryable,
    recoveryActions: input.recoveryActions,
    detail: {
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
      ...(input.sourceKey === undefined ? {} : { sourceKey: input.sourceKey }),
      ...(input.incomingRefs === undefined ? {} : { incomingRefs: input.incomingRefs }),
    },
  };
}

function confinedSourcePath(
  gameRoot: string,
  sourcePath: string,
): Result<{ readonly absolute: string; readonly relative: string }, ScriptablePackError> {
  const root = resolve(gameRoot);
  const absolute = resolve(root, sourcePath);
  const rel = relative(root, absolute);
  if (
    rel.length === 0 ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(sourcePath) ||
    !rel.endsWith('.pack.ts')
  ) {
    return err(
      authoringError('pack-source-path-invalid', {
        expected: 'a game-root-relative *.pack.ts path confined to the selected game',
        actual: sourcePath,
        hint: 'choose a relative ScriptablePack source path inside the selected game root',
        retryable: false,
        recoveryActions: ['choose-game-relative-source-path'],
        sourcePath,
      }),
    );
  }
  return ok({ absolute, relative: rel.split(sep).join('/') });
}

function revisionOf(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function literalValue(expression: ts.Expression): unknown {
  const value = unwrapExpression(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (ts.isArrayLiteralExpression(value)) return value.elements.map(literalValue);
  if (ts.isObjectLiteralExpression(value)) {
    const result: Record<string, unknown> = {};
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property))
        throw new TypeError('manifest properties must be data');
      const name = property.name;
      const key =
        ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
          ? name.text
          : undefined;
      if (key === undefined) throw new TypeError('manifest property names must be static');
      result[key] = literalValue(property.initializer);
    }
    return result;
  }
  throw new TypeError('manifest values must be literal data');
}

function parseCanonicalManifest(source: string, sourcePath: string): CanonicalManifest | undefined {
  if (!source.startsWith(`${CANONICAL_SCAFFOLD_MARKER}\n`)) return undefined;
  const file = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === CANONICAL_MANIFEST_NAME &&
        declaration.initializer !== undefined
      ) {
        const value = literalValue(declaration.initializer);
        if (value === null || typeof value !== 'object') return undefined;
        return value as CanonicalManifest;
      }
    }
  }
  return undefined;
}

function guidExpression(value: string): string {
  return `parseGuid(${JSON.stringify(value)})`;
}

/** Render the one source shape that the file authoring port may mutate structurally. */
export function renderCanonicalScriptablePack(manifest: CanonicalManifest): string {
  const data = JSON.stringify(manifest, null, 2);
  return `${CANONICAL_SCAFFOLD_MARKER}
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { buildMeshAttributeMapForUvSets } from '@forgeax/engine-geometry';
import type { ScriptablePackDefinition } from '@forgeax/engine-pack/source';
import type { Asset, AssetGuid as AssetGuidType } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';

const ${CANONICAL_MANIFEST_NAME} = ${data} as const;

function parseGuid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function createOutput(kind: string): Asset {
  switch (kind) {
    case 'scene':
      return { kind: 'scene', entities: [], mounts: [] };
    case 'material':
      return { kind: 'material', values: {} };
    case 'mesh': {
      const vertices = new Float32Array([
        0, 0.7, 0, 0, 0, 1, 0.5, 1, 0, 0, 0, 1,
        -0.7, -0.6, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1,
        0.7, -0.6, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1,
      ]);
      return {
        kind: 'mesh',
        vertices,
        indices: new Uint16Array([0, 1, 2]),
        attributes: { ...buildMeshAttributeMapForUvSets(1), position: vertices },
        aabb: new Float32Array([-0.7, -0.6, 0, 0.7, 0.7, 0]),
        submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 }],
        materialSlots: [{ slotName: 'Default' }],
      };
    }
    default:
      throw new Error(\`canonical ScriptablePack output kind is not mutable: \${kind}\`);
  }
}

const assets = Object.fromEntries(
  Object.entries(${CANONICAL_MANIFEST_NAME}.assets).map(([sourceKey, asset]) => [
    sourceKey,
    { ...asset, guid: parseGuid(asset.guid) },
  ]),
);
const externalAssets = Object.fromEntries(
  Object.entries(${CANONICAL_MANIFEST_NAME}.externalAssets).map(([alias, guid]) => [alias, parseGuid(guid)]),
);

export default {
  schemaVersion: '1.0.0',
  packageId: ${guidExpression(manifest.packageId)},
  ${manifest.name === undefined ? '' : `name: ${JSON.stringify(manifest.name)},\n  `}assets,
  externalAssets,
  build: () => ok(Object.fromEntries(Object.entries(assets).map(([sourceKey, asset]) => [sourceKey, createOutput(asset.kind)])) as Record<string, Asset>),
} satisfies ScriptablePackDefinition;
`;
}

function definitionFromCanonical(
  manifest: CanonicalManifest,
): Result<ScriptablePackDefinition, ScriptablePackError> {
  const packageId = AssetGuidCodec.parse(manifest.packageId);
  if (!packageId.ok) return invalidCanonicalGuid('$.packageId', manifest.packageId);
  const assets: Record<string, { guid: AssetGuid; kind: ScriptablePackAssetKind; name?: string }> =
    {};
  for (const [sourceKey, output] of Object.entries(manifest.assets)) {
    const guid = AssetGuidCodec.parse(output.guid);
    if (!guid.ok)
      return invalidCanonicalGuid(`$.assets[${JSON.stringify(sourceKey)}].guid`, output.guid);
    assets[sourceKey] = {
      guid: guid.value,
      kind: output.kind,
      ...(output.name === undefined ? {} : { name: output.name }),
    };
  }
  const externalAssets: Record<string, AssetGuid> = {};
  for (const [alias, value] of Object.entries(manifest.externalAssets)) {
    const guid = AssetGuidCodec.parse(value);
    if (!guid.ok) return invalidCanonicalGuid(`$.externalAssets[${JSON.stringify(alias)}]`, value);
    externalAssets[alias] = guid.value;
  }
  return validateScriptablePackDefinition({
    schemaVersion: '1.0.0',
    packageId: packageId.value,
    ...(manifest.name === undefined ? {} : { name: manifest.name }),
    assets,
    externalAssets,
    build: () => ok({} as Record<string, never>),
  });
}

function invalidCanonicalGuid(
  propertyPath: string,
  actual: string,
): Result<never, ScriptablePackError> {
  return err({
    code: 'pack-source-definition-invalid',
    expected: 'a canonical UUID string',
    hint: 'repair the canonical scaffold manifest GUID and inspect Meta again',
    detail: { propertyPath, actual },
  });
}

function invalidCanonicalSource(
  sourcePath: string,
  error: unknown,
): Result<never, ScriptablePackError> {
  return err({
    code: 'pack-source-definition-invalid',
    expected: 'a literal canonical-v1 manifest with the required package/assets/external fields',
    hint: 'repair the canonical scaffold or open it as custom source without structured mutation',
    detail: {
      sourcePath,
      propertyPath: '$.canonicalManifest',
      actual: error instanceof Error ? error.message : String(error),
    },
  });
}

async function atomicWrite(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('\0') === [...right].sort().join('\0');
}

/** Node filesystem adapter for the public ScriptablePack authoring gateway. */
export function createFileSystemScriptablePackAuthoringPort(
  options: FileSystemScriptablePackAuthoringOptions,
): ScriptablePackAuthoringPort {
  const resolvePath = (sourcePath: string) => confinedSourcePath(options.gameRoot, sourcePath);

  async function readSource(sourcePath: string) {
    const path = resolvePath(sourcePath);
    if (!path.ok) return path;
    try {
      const source = await readFile(path.value.absolute, 'utf8');
      return ok({ ...path.value, source, revision: revisionOf(source) });
    } catch (error) {
      return err(
        authoringError('pack-source-write-failed', {
          expected: 'a readable ScriptablePack source file',
          actual: error instanceof Error ? error.message : String(error),
          hint: 'restore the source file or create it through the ScriptablePack gateway',
          retryable: true,
          recoveryActions: ['inspect-source-path', 'retry'],
          sourcePath,
        }),
      );
    }
  }

  async function inspect(sourcePath: string) {
    const read = await readSource(sourcePath);
    if (!read.ok) return read;
    let canonical: CanonicalManifest | undefined;
    try {
      canonical = parseCanonicalManifest(read.value.source, read.value.relative);
    } catch (error) {
      return invalidCanonicalSource(read.value.relative, error);
    }
    const loaded =
      canonical === undefined
        ? await loadScriptablePack(read.value.absolute, { metadataOnly: true })
        : definitionFromCanonical(canonical);
    if (!loaded.ok) return loaded;
    return ok({
      revision: read.value.revision,
      meta: projectScriptablePackMeta(loaded.value, read.value.relative),
    });
  }

  async function preflight(sourcePath: string) {
    const read = await readSource(sourcePath);
    if (!read.ok) return read;
    const inspected = await inspect(sourcePath);
    if (!inspected.ok) return inspected;
    let canonical: CanonicalManifest | undefined;
    try {
      canonical = parseCanonicalManifest(read.value.source, read.value.relative);
    } catch (error) {
      return invalidCanonicalSource(read.value.relative, error);
    }
    const incomingRefs = (await options.incomingRefs?.(read.value.relative)) ?? [];
    return ok({
      revision: inspected.value.revision,
      meta: inspected.value.meta,
      capabilities:
        canonical === undefined
          ? ({
              inspect: true,
              rebuild: true,
              coldCook: true,
              reason: 'structured mutation is available only for canonical-v1 scaffolds',
            } as const)
          : ({
              inspect: true,
              rebuild: true,
              coldCook: true,
              addOutput: true,
              addExternalAsset: true,
              renameDisplay: true,
              removeOutput: true,
              clone: true,
            } as const),
      incomingRefs,
    });
  }

  async function mutate(operation: ScriptablePackAuthoringMutation) {
    const targetPath =
      operation.kind === 'clone-scriptable-pack' ? operation.targetPath : operation.sourcePath;
    const target = resolvePath(targetPath);
    if (!target.ok) return target;

    let manifest: CanonicalManifest;
    let currentRevision: string | undefined;
    if (operation.kind === 'create-scriptable-pack') {
      if (!CANONICAL_MUTABLE_KINDS.has(operation.initialOutput.kind)) {
        return err(
          authoringError('pack-source-mutation-unsupported', {
            expected: 'a canonical scene, mesh, or material initial output',
            actual: operation.initialOutput.kind,
            hint: 'create one of the canonical output kinds, then hand-author advanced outputs',
            retryable: false,
            recoveryActions: ['choose-supported-output-kind'],
            requestId: operation.requestId,
            sourcePath: operation.sourcePath,
          }),
        );
      }
      try {
        await stat(target.value.absolute);
        return err(
          authoringError('pack-source-revision-conflict', {
            expected: 'an unused target source path',
            actual: 'source already exists',
            hint: 'inspect the existing source or choose a new path',
            retryable: false,
            recoveryActions: ['asset.preflight', 'choose-new-source-path'],
            requestId: operation.requestId,
            sourcePath: operation.sourcePath,
          }),
        );
      } catch {
        // Missing is the required create precondition.
      }
      manifest = {
        schemaVersion: '1.0.0',
        packageId: AssetGuidCodec.format(operation.packageId),
        ...(operation.name === undefined ? {} : { name: operation.name }),
        assets: {
          [operation.initialOutput.sourceKey]: {
            guid: AssetGuidCodec.format(operation.initialOutput.guid),
            kind: operation.initialOutput.kind,
            ...(operation.initialOutput.name === undefined
              ? {}
              : { name: operation.initialOutput.name }),
          },
        },
        externalAssets: {},
      };
    } else {
      const read = await readSource(operation.sourcePath);
      if (!read.ok) return read;
      currentRevision = read.value.revision;
      if (
        operation.expectedRevision !== undefined &&
        operation.expectedRevision !== currentRevision
      ) {
        return err(
          authoringError('pack-source-revision-conflict', {
            expected: operation.expectedRevision,
            actual: currentRevision,
            hint: 'inspect the current source revision, reconcile the edit, then retry with a new requestId',
            retryable: true,
            recoveryActions: ['asset.preflight', 'mint-request-id'],
            requestId: operation.requestId,
            sourcePath: operation.sourcePath,
          }),
        );
      }
      let parsed: CanonicalManifest | undefined;
      try {
        parsed = parseCanonicalManifest(read.value.source, read.value.relative);
      } catch (error) {
        return invalidCanonicalSource(read.value.relative, error);
      }
      if (parsed === undefined) {
        return err(
          authoringError('pack-source-mutation-unsupported', {
            expected: 'a canonical-v1 scaffold for structured source mutation',
            actual: 'custom ScriptablePack source',
            hint: 'clone into a canonical scaffold or edit custom source with a code editor',
            retryable: false,
            recoveryActions: ['clone-scriptable-pack', 'open-code-editor'],
            requestId: operation.requestId,
            sourcePath: operation.sourcePath,
          }),
        );
      }
      manifest = parsed;
    }

    if (operation.kind === 'clone-scriptable-pack') {
      try {
        await stat(target.value.absolute);
        return err(
          authoringError('pack-source-revision-conflict', {
            expected: 'an unused clone target source path',
            actual: 'source already exists',
            hint: 'inspect the existing target or choose a new path',
            retryable: false,
            recoveryActions: ['asset.preflight', 'choose-new-source-path'],
            requestId: operation.requestId,
            sourcePath: target.value.relative,
          }),
        );
      } catch {
        // Missing is the required clone precondition.
      }
    }

    if (operation.kind === 'add-output') {
      if (!CANONICAL_MUTABLE_KINDS.has(operation.assetKind)) {
        return err(
          authoringError('pack-source-mutation-unsupported', {
            expected: 'a canonical scene, mesh, or material output',
            actual: operation.assetKind,
            hint: 'hand-author advanced output kinds in the source module',
            retryable: false,
            recoveryActions: ['open-code-editor'],
            requestId: operation.requestId,
            sourcePath: operation.sourcePath,
            sourceKey: operation.sourceKey,
          }),
        );
      }
      manifest = {
        ...manifest,
        assets: {
          ...manifest.assets,
          [operation.sourceKey]: {
            guid: AssetGuidCodec.format(operation.guid),
            kind: operation.assetKind,
            ...(operation.name === undefined ? {} : { name: operation.name }),
          },
        },
      };
    } else if (operation.kind === 'add-external-asset') {
      manifest = {
        ...manifest,
        externalAssets: {
          ...manifest.externalAssets,
          [operation.alias]: AssetGuidCodec.format(operation.guid),
        },
      };
    } else if (operation.kind === 'rename-display') {
      if (operation.target.kind === 'package') manifest = { ...manifest, name: operation.name };
      else {
        const output = manifest.assets[operation.target.sourceKey];
        if (output === undefined)
          return err(
            authoringError('pack-source-mutation-unsupported', {
              expected: 'an existing sourceKey',
              actual: operation.target.sourceKey,
              hint: 'inspect Meta and choose a current output',
              retryable: true,
              recoveryActions: ['asset.preflight'],
              requestId: operation.requestId,
              sourcePath: operation.sourcePath,
              sourceKey: operation.target.sourceKey,
            }),
          );
        manifest = {
          ...manifest,
          assets: {
            ...manifest.assets,
            [operation.target.sourceKey]: { ...output, name: operation.name },
          },
        };
      }
    } else if (operation.kind === 'remove-output') {
      const incomingRefs =
        (await options.incomingRefs?.(operation.sourcePath, operation.sourceKey)) ?? [];
      if (
        incomingRefs.length > 0 &&
        !sameStrings(incomingRefs, operation.confirmIncomingRefs ?? [])
      ) {
        return err(
          authoringError('pack-source-reference-conflict', {
            expected: 'explicit acknowledgement of every current incoming reference',
            actual: `${incomingRefs.length} incoming references`,
            hint: 'inspect dependents, then confirm the exact incoming reference identities or cancel',
            retryable: true,
            recoveryActions: ['inspect-incoming-refs', 'confirm-remove-output'],
            requestId: operation.requestId,
            sourcePath: operation.sourcePath,
            sourceKey: operation.sourceKey,
            incomingRefs,
          }),
        );
      }
      const { [operation.sourceKey]: removed, ...assets } = manifest.assets;
      if (removed === undefined || Object.keys(assets).length === 0) {
        return err(
          authoringError('pack-source-mutation-unsupported', {
            expected: 'an existing output while retaining at least one package output',
            actual: operation.sourceKey,
            hint: 'keep one output or remove the entire source file through an explicit file operation',
            retryable: false,
            recoveryActions: ['asset.preflight'],
            requestId: operation.requestId,
            sourcePath: operation.sourcePath,
            sourceKey: operation.sourceKey,
          }),
        );
      }
      manifest = { ...manifest, assets };
    } else if (operation.kind === 'clone-scriptable-pack') {
      manifest = {
        ...manifest,
        packageId: AssetGuidCodec.format(operation.packageId),
        assets: Object.fromEntries(
          Object.entries(manifest.assets).map(([sourceKey, output]) => [
            sourceKey,
            {
              ...output,
              guid: AssetGuidCodec.format(operation.outputGuids[sourceKey] as AssetGuid),
            },
          ]),
        ),
      };
    }

    const source = renderCanonicalScriptablePack(manifest);
    try {
      await atomicWrite(target.value.absolute, source);
      return ok({ sourcePath: target.value.relative, revision: revisionOf(source) });
    } catch (error) {
      return err(
        authoringError('pack-source-write-failed', {
          expected: 'an atomic source-file replacement',
          actual: error instanceof Error ? error.message : String(error),
          hint: 'repair filesystem permissions or disk capacity, then retry with a new requestId',
          retryable: true,
          recoveryActions: ['inspect-filesystem', 'mint-request-id'],
          requestId: operation.requestId,
          sourcePath: target.value.relative,
        }),
      );
    }
  }

  return {
    preflight,
    mutate,
    inspect,
    async rebuild(sourcePath, mode) {
      const path = resolvePath(sourcePath);
      if (!path.ok) return path;
      const rebuilt = (await options.rebuild?.(path.value.relative, mode)) ?? ok(undefined);
      return rebuilt.ok ? inspect(path.value.relative) : rebuilt;
    },
  };
}
