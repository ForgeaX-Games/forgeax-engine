import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import { assembleTape, type EncodedTape } from './assemble';
import { createRecorderProxy, type RecordableBackend, type RecorderBackend } from './proxy';
import { ResourceRegistry } from './resource-registry';
import { snapshotFrame } from './snapshot';

export interface CaptureFrameOptions {
  readonly snapshotTimeoutMs?: number;
  readonly byteBudget?: number;
  readonly signal?: AbortSignal;
}

export interface RecorderOptions {
  readonly snapshotTimeoutMs?: number;
  readonly byteBudget?: number;
}

export interface RecorderAttachment {
  readonly backend: RecorderBackend;
  captureFrame(options?: CaptureFrameOptions): Promise<Result<EncodedTape, RhiDebugError>>;
  frameBoundary(): Promise<Result<void, RhiDebugError>>;
  deviceLost(): void;
  dispose(): Promise<Result<void, RhiDebugError>>;
}

type Phase = 'idle' | 'armed' | 'snapshotting' | 'recording' | 'disposed';

export function attachRecorder(
  backend: RecordableBackend,
  options: RecorderOptions = {},
): Result<RecorderAttachment, RhiDebugError> {
  const proxy = createRecorderProxy(backend);
  const registry = new ResourceRegistry(proxy.recorder);
  let phase: Phase = 'idle';
  let generation = 0;
  let active:
    | {
        readonly generation: number;
        readonly options: CaptureFrameOptions;
        readonly resolve: (result: Result<EncodedTape, RhiDebugError>) => void;
        readonly signal?: AbortSignal;
        abortListener?: () => void;
      }
    | undefined;

  const fail = <T>(
    code: 'capture-unavailable' | 'capture-busy',
    cause: string,
  ): Result<T, RhiDebugError> => err(createRhiDebugError(code, { stage: 'capture', cause }));

  const settle = (result: Result<EncodedTape, RhiDebugError>): void => {
    const request = active;
    if (request === undefined) return;
    active = undefined;
    request.signal?.removeEventListener('abort', request.abortListener ?? (() => {}));
    if (!result.ok && proxy.recorder.getState() === 'error') proxy.recorder.disposeError();
    phase = phase === 'disposed' ? 'disposed' : 'idle';
    request.resolve(result);
  };

  const abort = (): void => {
    if (active === undefined) return;
    proxy.recorder.transitionToError();
    settle(fail('capture-unavailable', 'capture request was aborted'));
  };

  const attachment: RecorderAttachment = {
    backend: proxy.backend,
    captureFrame(captureOptions = {}) {
      if (phase === 'disposed')
        return Promise.resolve(fail('capture-unavailable', 'recorder is disposed'));
      if (active !== undefined)
        return Promise.resolve(fail('capture-busy', 'another capture is active'));
      const signal = captureOptions.signal;
      if (signal?.aborted)
        return Promise.resolve(fail('capture-unavailable', 'capture request was aborted'));
      const arm = proxy.recorder.arm(1);
      if (!arm.ok) return Promise.resolve(fail('capture-busy', arm.error.hint));
      phase = 'armed';
      generation += 1;
      return new Promise<Result<EncodedTape, RhiDebugError>>((resolve) => {
        const request = {
          generation,
          options: captureOptions,
          resolve,
          ...(signal === undefined ? {} : { signal }),
        } as {
          readonly generation: number;
          readonly options: CaptureFrameOptions;
          readonly resolve: (result: Result<EncodedTape, RhiDebugError>) => void;
          readonly signal?: AbortSignal;
          abortListener?: () => void;
        };
        request.abortListener = abort;
        active = request;
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
    async frameBoundary() {
      if (phase === 'disposed' || active === undefined) return ok(undefined);
      const request = active;
      if (request.generation !== generation) return ok(undefined);
      if (phase === 'armed') {
        phase = 'snapshotting';
        const result = await snapshotFrame(proxy.recorder, registry, {
          snapshotTimeoutMs:
            request.options.snapshotTimeoutMs ?? options.snapshotTimeoutMs ?? 30_000,
          byteBudget: request.options.byteBudget ?? options.byteBudget ?? Number.MAX_SAFE_INTEGER,
        });
        if (!result.ok) {
          proxy.recorder.transitionToError();
          settle(err(result.error));
          return err(result.error);
        }
        phase = 'recording';
        return ok(undefined);
      }
      if (phase !== 'recording') return ok(undefined);
      proxy.recorder.onFrameEnd();
      if (proxy.recorder.getState() !== 'idle') return ok(undefined);
      const result = assembleTape(proxy.recorder);
      settle(result);
      return result.ok ? ok(undefined) : err(result.error);
    },
    deviceLost() {
      generation += 1;
      registry.clearGeneration();
      if (active !== undefined) {
        phase = 'idle';
        settle(fail('capture-unavailable', 'device loss invalidated the active generation'));
      } else if (phase !== 'disposed') {
        phase = 'idle';
      }
    },
    async dispose() {
      if (phase === 'disposed') return ok(undefined);
      if (active !== undefined) {
        proxy.recorder.transitionToError();
        settle(fail('capture-unavailable', 'recorder was disposed during capture'));
      }
      proxy.recorder.disposeError();
      phase = 'disposed';
      return ok(undefined);
    },
  };
  return ok(attachment);
}

export type { CreateShaderModuleFn } from '../recorder';
export type { EncodedTape } from './assemble';
export type { RecordableBackend, RecorderBackend } from './proxy';
