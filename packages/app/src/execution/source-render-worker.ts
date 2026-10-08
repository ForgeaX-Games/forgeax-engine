import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import {
  createRenderPublisher,
  type GpuPassTimingObservation,
  type RenderFeature,
  type RenderPublicationTargetOwner,
  type RenderSceneBounds,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import {
  type CaptureFrameOptions,
  createRhiDebugError,
  tapeArtifact,
} from '@forgeax/engine-rhi-debug';
import { err, ok } from '@forgeax/engine-types';
import { type RhiCapture, toArtifact, uploadRhiTape } from '../internal/rhi-capture';
import type { EngineToHostMessage, ExecutionFrameMessage, ExecutionInitMessage } from './protocol';
import type { RenderWorkerInput, RenderWorkerOutput } from './render-worker-protocol';
import { workerError } from './worker-error';
import { shutdownWorker } from './worker-shutdown';

type CaptureResult = Awaited<ReturnType<RhiCapture['captureFrame']>>;

/** Two sealed publications; Host admission bounds simulation to the same capacity. */
export class SourceRenderWorker {
  private worker: Worker | undefined;
  private publisher: ReturnType<typeof createRenderPublisher> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private epoch = 1;
  private readonly source = crypto.randomUUID();
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private readyWait: Promise<void> = Promise.resolve();
  private resolveReady: (() => void) | undefined;
  private replacementsWithoutFrame = 0;
  private nextRequestId = 0;
  private latestCompletedTerrainFrame: number | undefined;
  private readonly boundsRequests = new Map<
    number,
    {
      finish(bounds: RenderSceneBounds | undefined): void;
      fail(cause: Error): void;
    }
  >();
  private readonly terrainRequests = new Map<
    number,
    {
      finish(
        result: import('@forgeax/engine-types').Result<
          number | undefined,
          import('@forgeax/engine-types').TerrainError
        >,
      ): void;
    }
  >();
  private captureRequest: { id: number; finish(result: CaptureResult): void } | undefined;
  private latestGpuPassTiming:
    | { readonly frameId: number; readonly observation: GpuPassTimingObservation }
    | undefined;
  constructor(
    private readonly world: World,
    private readonly assets: AssetRegistry,
    private readonly init: ExecutionInitMessage,
    private readonly post: (message: EngineToHostMessage) => void,
    private readonly features: readonly RenderFeature<unknown>[] = [],
    private readonly targets?: RenderPublicationTargetOwner,
  ) {}

  async start(canvas: OffscreenCanvas): Promise<void> {
    if (this.disposed) return;
    const epoch = this.epoch;
    const worker = new Worker(new URL('./render-worker-runtime.mjs', import.meta.url), {
      type: 'module',
      name: 'forgeax-render',
    });
    this.worker = worker;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const failure = (
        cause: unknown,
        failure?: Extract<RenderWorkerOutput, { kind: 'failed' }>,
        recoverable = failure?.recoverable ?? true,
      ): void => {
        const error = failure?.error ?? workerError(cause);
        const detail = {
          ...error,
          stage: failure?.stage ?? 'transport',
          publication: failure?.publication,
        };
        if (this.worker !== worker) return;
        this.clear();
        if (!ready) {
          reject(Object.assign(new Error(typeof cause === 'string' ? cause : error.code), error));
          return;
        }
        if (!recoverable || ++this.replacementsWithoutFrame > 1) {
          this.post({
            kind: 'fault',
            source: 'runtime',
            worldIdentity: this.world.identity,
            ...error,
            detail: { cause: error.detail, stage: detail.stage, publication: detail.publication },
            partialWrite: false,
            retryable: false,
          });
          return;
        }
        this.readyWait = new Promise((resolve) => {
          this.resolveReady = resolve;
        });
        this.epoch++;
        this.post({ kind: 'render-lost', epoch: this.epoch, detail: JSON.stringify(detail) });
      };
      this.deadline = setTimeout(
        () => failure('Render Worker initialization timed out'),
        this.init.startupTimeoutMs,
      );
      worker.onerror = (event) => failure(event.message);
      worker.onmessage = (event: MessageEvent<RenderWorkerOutput>) => {
        if (this.worker !== worker || this.epoch !== epoch) return;
        const message = event.data;
        if (message.kind === 'terrain-height-result') {
          this.terrainRequests
            .get(message.requestId)
            ?.finish(message.result.ok ? ok(message.result.value) : err(message.result.error));
          return;
        }
        if (message.kind === 'bounds-result') {
          this.boundsRequests.get(message.requestId)?.finish(message.bounds);
          return;
        }
        if (message.kind === 'capture-result') {
          if (this.captureRequest?.id === message.requestId)
            this.captureRequest.finish(
              message.result.ok
                ? ok(toArtifact(tapeArtifact([message.result.value.bytes])))
                : err(message.result.error),
            );
          return;
        }
        if (message.kind === 'failed') {
          failure(message.error, message);
          return;
        }
        if (message.kind === 'ready') {
          clearTimeout(this.deadline);
          this.publisher = createRenderPublisher(
            this.world,
            this.assets,
            {
              source: this.source,
              epoch,
            },
            message.capabilities,
            this.features,
            this.targets,
            message.limits,
          );
          ready = true;
          this.resolveReady?.();
          this.resolveReady = undefined;
          this.post({ kind: 'render-ready', epoch });
          resolve();
        } else if (message.kind === 'submitted') {
          try {
            const accepted = this.publisher?.acknowledgeFeatures(
              message.revision,
              message.features,
            );
            if (accepted?.ok !== true) {
              failure(
                accepted?.error ?? new Error('Invalid feature acknowledgment'),
                undefined,
                false,
              );
              return;
            }
          } catch (cause) {
            failure(cause, undefined, false);
            return;
          }
          this.post({ kind: 'render-submitted', epoch, frame: message.frame });
        } else if (message.kind === 'completed') {
          clearTimeout(this.deadline);
          const recycled = this.publisher?.recycle(message.revision, message.buffers);
          if (recycled?.ok !== true) {
            failure(
              recycled?.error ?? new Error('Invalid Render Worker buffer return'),
              undefined,
              false,
            );
            return;
          }
          this.replacementsWithoutFrame = 0;
          if (
            message.frame.presentation === 'ready' &&
            (this.latestCompletedTerrainFrame === undefined ||
              message.frame.frameId > this.latestCompletedTerrainFrame)
          )
            this.latestCompletedTerrainFrame = message.frame.frameId;
          if (message.gpuPassTiming !== undefined) {
            this.latestGpuPassTiming = {
              frameId: message.frame.frameId,
              observation: message.gpuPassTiming,
            };
          }
          this.post({ kind: 'render-complete', epoch, frame: message.frame });
          if (this.publisher?.inspect().inFlight) this.armFrameDeadline();
        }
      };
      worker.postMessage(
        {
          kind: 'init',
          ...(this.init.diagnostics?.rhiCapture === true ? { rhiCapture: true } : {}),
          ...(this.init.diagnostics?.gpuPassTiming === undefined
            ? {}
            : { gpuPassTiming: this.init.diagnostics.gpuPassTiming }),
          ...(this.init.outputColorSpace === undefined
            ? {}
            : { outputColorSpace: this.init.outputColorSpace }),
          bootstrapUrl: this.init.bootstrapUrl,
          ...(this.init.bootstrapData === undefined
            ? {}
            : { bootstrapData: this.init.bootstrapData }),
          canvas,
          identity: { source: this.source, epoch },
          ...(this.init.shaderManifestUrl === undefined
            ? {}
            : { shaderManifestUrl: this.init.shaderManifestUrl }),
          ...(this.init.build === undefined ? {} : { build: this.init.build }),
        } satisfies RenderWorkerInput,
        [canvas],
      );
      // The same failure owner handles a GPU queue that never completes.
      this.armFrameDeadline = () => {
        this.deadline = setTimeout(() => failure('Render Worker frame timed out'), 30_000);
      };
    });
  }
  private armFrameDeadline: () => void = () => {};
  async waitUntilReady(): Promise<boolean> {
    await this.readyWait;
    return !this.disposed;
  }
  publish(frame: ExecutionFrameMessage, sampleTimeSeconds: number): void {
    const publisher = this.publisher,
      worker = this.worker;
    if (publisher === undefined || worker === undefined)
      throw new Error('Render Worker is not ready');
    const wasIdle = !publisher.inspect().inFlight;
    const candidate = publisher.prepare(sampleTimeSeconds, frame.temporalReset === true).unwrap();
    try {
      worker.postMessage(
        {
          kind: 'draw',
          worldIdentity: this.world.identity,
          frameId: frame.frameId,
          width: frame.canvasWidth,
          height: frame.canvasHeight,
          publication: candidate.packet,
        } satisfies RenderWorkerInput,
        renderPublicationTransfers(candidate.packet),
      );
      candidate.accept();
      if (wasIdle) this.armFrameDeadline();
    } catch (cause) {
      candidate.discard();
      throw cause;
    }
  }
  queryLatestSubmittedTerrainHeight(
    request: import('@forgeax/engine-render').SubmittedTerrainHeightRequest,
  ) {
    const frameId = this.latestCompletedTerrainFrame;
    if (frameId === undefined)
      return Promise.resolve(
        err({
          code: 'terrain-query-unavailable' as const,
          expected: 'a completed ready picture in the current Render Worker session',
          hint: 'keep dependent gameplay isolated until the new terrain has rendered',
          detail: { field: 'FrameReceipt' },
        }),
      );
    return this.querySubmittedTerrainHeight(frameId, request);
  }
  querySubmittedTerrainHeight(
    frameId: number,
    request: import('@forgeax/engine-render').SubmittedTerrainHeightRequest,
  ): Promise<
    import('@forgeax/engine-types').Result<
      number | undefined,
      import('@forgeax/engine-types').TerrainError
    >
  > {
    const unavailable = (cause: string) =>
      err({
        code: 'terrain-query-unavailable' as const,
        expected: 'a retained successful frame in the active Render Worker session',
        hint: 'wait for frame completion and query its exact frame ID',
        detail: { field: 'Worker', actual: cause },
      });
    const worker = this.worker;
    if (worker === undefined || this.terrainRequests.size >= 32)
      return Promise.resolve(unavailable('session ended or request budget exhausted'));
    const requestId = ++this.nextRequestId;
    return new Promise((resolve) => {
      const finish = (
        result: import('@forgeax/engine-types').Result<
          number | undefined,
          import('@forgeax/engine-types').TerrainError
        >,
      ) => {
        clearTimeout(deadline);
        this.terrainRequests.delete(requestId);
        resolve(result);
      };
      const deadline = setTimeout(() => finish(unavailable('query deadline exceeded')), 30_000);
      this.terrainRequests.set(requestId, { finish });
      try {
        worker.postMessage({
          kind: 'terrain-height',
          requestId,
          frameId,
          request,
        } satisfies RenderWorkerInput);
      } catch (cause) {
        finish(unavailable(String(cause)));
      }
    });
  }
  bounds(entity: number): Promise<RenderSceneBounds | undefined> {
    const worker = this.worker;
    if (worker === undefined) return Promise.reject(new Error('Render Worker session ended'));
    const requestId = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const remove = () => {
        clearTimeout(deadline);
        this.boundsRequests.delete(requestId);
      };
      const fail = (cause: Error) => {
        remove();
        reject(cause);
      };
      const deadline = setTimeout(
        () => fail(new Error('Render Worker bounds request timed out')),
        30_000,
      );
      this.boundsRequests.set(requestId, {
        finish: (bounds) => {
          remove();
          resolve(bounds);
        },
        fail,
      });
      try {
        worker.postMessage({ kind: 'bounds', requestId, entity } satisfies RenderWorkerInput);
      } catch (cause) {
        fail(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }
  readonly upload: RhiCapture['upload'] = uploadRhiTape;

  captureFrame(options: CaptureFrameOptions = {}): Promise<CaptureResult> {
    const unavailable = (cause: string): CaptureResult =>
      err(createRhiDebugError('capture-unavailable', { stage: 'capture', cause }));
    const worker = this.worker;
    if (
      worker === undefined ||
      this.init.diagnostics?.rhiCapture !== true ||
      options.signal?.aborted
    )
      return Promise.resolve(unavailable('Render Worker capture is unavailable or cancelled'));
    if (this.captureRequest !== undefined)
      return Promise.resolve(
        err(
          createRhiDebugError('capture-busy', {
            stage: 'capture',
            cause: 'a Render Worker capture is active',
          }),
        ),
      );
    const id = ++this.nextRequestId;
    return new Promise((resolve) => {
      const cancel = () => {
        worker.postMessage({ kind: 'capture-cancel', requestId: id } satisfies RenderWorkerInput);
        finish(
          unavailable(
            'Render Worker capture was cancelled or did not complete before its deadline',
          ),
        );
      };
      const deadline = setTimeout(cancel, (options.snapshotTimeoutMs ?? 30_000) + 30_000);
      const finish = (result: CaptureResult) => {
        if (this.captureRequest?.id !== id) return;
        this.captureRequest = undefined;
        clearTimeout(deadline);
        options.signal?.removeEventListener('abort', cancel);
        resolve(result);
      };
      this.captureRequest = { id, finish };
      options.signal?.addEventListener('abort', cancel, { once: true });
      const { signal: _signal, ...configuration } = options;
      try {
        worker.postMessage({
          kind: 'capture',
          requestId: id,
          options: configuration,
        } satisfies RenderWorkerInput);
      } catch (cause) {
        finish(unavailable(String(cause)));
      }
    });
  }
  inspectGpuPassTiming():
    | { readonly frameId: number; readonly observation: GpuPassTimingObservation }
    | undefined {
    return this.latestGpuPassTiming;
  }
  async replace(epoch: number, canvas: OffscreenCanvas): Promise<void> {
    if (epoch !== this.epoch || this.worker !== undefined || this.disposed) return;
    await this.start(canvas);
  }
  private clear(): void {
    for (const request of this.terrainRequests.values())
      request.finish(
        err({
          code: 'terrain-query-unavailable',
          expected: 'an active Render Worker session',
          hint: 'query after recovery completes',
          detail: { field: 'Worker' },
        }),
      );
    for (const request of this.boundsRequests.values())
      request.fail(new Error('Render Worker session ended'));
    this.captureRequest?.finish(
      err(
        createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: 'Render Worker session ended',
        }),
      ),
    );
    clearTimeout(this.deadline);
    this.worker?.terminate();
    this.worker = undefined;
    this.latestGpuPassTiming = undefined;
    this.latestCompletedTerrainFrame = undefined;
    this.publisher?.dispose();
    this.publisher = undefined;
  }
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.disposed = true;
    this.resolveReady?.();
    clearTimeout(this.deadline);
    const worker = this.worker;
    // Fence late frame/capture messages before waiting for the dedicated ACK.
    this.worker = undefined;
    this.disposal = (async () => {
      try {
        if (worker !== undefined) (await shutdownWorker(worker)).unwrap();
      } finally {
        this.clear();
      }
    })();
    return this.disposal;
  }
}
